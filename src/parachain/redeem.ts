import { PolkaBTC, RedeemRequest, H256Le } from "../interfaces/default";
import { ApiPromise } from "@polkadot/api";
import { AddressOrPair, SubmittableExtrinsic } from "@polkadot/api/submittable/types";
import { AccountId, Hash, H256, Header } from "@polkadot/types/interfaces";
import { Bytes } from "@polkadot/types/primitive";
import { EventRecord } from "@polkadot/types/interfaces/system";
import { VaultsAPI, DefaultVaultsAPI } from "./vaults";
import {
    decodeBtcAddress,
    pagedIterator,
    decodeFixedPointType,
    Transaction,
    encodeParachainRequest,
    ACCOUNT_NOT_SET_ERROR_MESSAGE,
    btcToSat,
    satToBTC,
    planckToDOT
} from "../utils";
import { BlockNumber } from "@polkadot/types/interfaces/runtime";
import { stripHexPrefix } from "../utils";
import { Network } from "bitcoinjs-lib";
import Big from "big.js";
import { allocateAmountsToVaults, getRequestIdsFromEvents, RequestOptions } from "../utils/issueRedeem";
import BN from "bn.js";
import { CollateralAPI } from ".";
import { DefaultCollateralAPI } from "./collateral";

export type RequestResult = { id: Hash; redeemRequest: RedeemRequestExt };

export interface RedeemRequestExt extends Omit<RedeemRequest, "btc_address"> {
    // network encoded btc address
    btc_address: string;
}

export function encodeRedeemRequest(req: RedeemRequest, network: Network): RedeemRequestExt {
    return encodeParachainRequest<RedeemRequest, RedeemRequestExt>(req, network);
}

/**
 * @category PolkaBTC Bridge
 */
export interface RedeemAPI {
    /**
     * @returns An array containing the redeem requests
     */
    list(): Promise<RedeemRequestExt[]>;
    /**
     * Request redeeming PolkaBTC.
     * @param amountSat PolkaBTC amount (denoted in Satoshi) to redeem
     * @param btcAddressEnc Bitcoin address where the redeemed BTC should be sent
     * @param options (optional): an object specifying
     * - atomic (optional) Whether the request should be handled atomically or not. Only makes a difference
     * if more than one vault is needed to fulfil it. Defaults to false.
     * - availableVaults (optional) A list of all vaults usable for redeem. If not provided, will fetch from the parachain.
     * - retries (optional) Number of times to re-try redeeming, if some of the requests fail. Defaults to 0.
     * @returns An array of type {redeemId, redeemRequest} if the requests succeeded. The function throws an error otherwise.
     */
    request(amount: BN, btcAddressEnc: string, options?: RequestOptions): Promise<RequestResult[]>;

    /**
     * Send a batch of aggregated redeem transactions (to one or more vaults)
     * @param amountsPerVault A mapping of vaults to redeem from, and PolkaBTC amounts (in Satoshi) to redeem using each vault
     * @param btcAddressEnc Bitcoin address where the redeemed BTC should be sent
     * @param atomic Whether the issue request should be handled atomically or not. Only makes a difference if more than
     * one vault is needed to fulfil it.
     * @returns An array of type {redeemId, vault} if the requests succeeded.
     * @throws Rejects the promise if none of the requests succeeded (or if at least one failed, when atomic=true).
     */
    requestAdvanced(
        amountsPerVault: Map<AccountId, BN>,
        btcAddressEnc: string,
        atomic: boolean
    ): Promise<RequestResult[]>;

    /**
     * Send a redeem execution transaction
     * @param redeemId The ID returned by the redeem request transaction
     * @param txId The ID of the Bitcoin transaction that sends funds from the vault to the redeemer's address
     * @param merkleProof The merkle inclusion proof of the Bitcoin transaction
     * @param rawTx The raw bytes of the Bitcoin transaction
     * @returns A boolean value indicating whether the execution was successful. The function throws an error otherwise.
     */
    execute(redeemId: H256, txId: H256Le, merkleProof: Bytes, rawTx: Bytes): Promise<boolean>;
    /**
     * Send a redeem cancellation transaction. After the redeem period has elapsed,
     * the redeemal of PolkaBTC can be cancelled. As a result, the griefing collateral
     * of the vault will be slashed and sent to the redeemer
     * @param redeemId The ID returned by the redeem request transaction
     * @param reimburse (Optional) In case of redeem failure:
     *  - `false` = retry redeeming, with a different Vault
     *  - `true` = accept reimbursement in polkaBTC
     */
    cancel(redeemId: H256, reimburse?: boolean): Promise<void>;
    /**
     * Set an account to use when sending transactions from this API
     * @param account Keyring account
     */
    setAccount(account: AddressOrPair): void;
    /**
     * @param perPage Number of redeem requests to iterate through at a time
     * @returns An AsyncGenerator to be used as an iterator
     */
    getPagedIterator(perPage: number): AsyncGenerator<RedeemRequest[]>;
    /**
     * @param account The ID of the account whose redeem requests are to be retrieved
     * @returns A mapping from the redeem request ID to the redeem request object, corresponding to the requests of
     * the given account
     */
    mapForUser(account: AccountId): Promise<Map<H256, RedeemRequestExt>>;
    /**
     * @param redeemId The ID of the redeem request to fetch
     * @returns A redeem request object
     */
    getRequestById(redeemId: H256): Promise<RedeemRequestExt>;
    getRequestsById(redeemIds: H256[]): Promise<RedeemRequestExt[]>;
    /**
     * Whenever a redeem request associated with `account` expires, call the callback function with the
     * ID of the expired request. Already expired requests are stored in memory, so as not to call back
     * twice for the same request.
     * @param account The ID of the account whose redeem requests are to be checked for expiry
     * @param callback Function to be called whenever a redeem request expires
     */
    subscribeToRedeemExpiry(account: AccountId, callback: (requestRedeemId: H256) => void): Promise<() => void>;
    /**
     * @returns The minimum amount of btc that is accepted for redeem requests; any lower values would
     * risk the bitcoin client to reject the payment
     */
    getDustValue(): Promise<PolkaBTC>;
    /**
     * @returns The fee charged for redeeming. For instance, "0.005" stands for 0.5%
     */
    getFeeRate(): Promise<Big>;
    /**
     * @param amountBtc The amount, in BTC, for which to compute the redeem fees
     * @returns The fees, in BTC
     */
    getFeesToPay(amount: string): Promise<string>;
    /**
     * @returns If users execute a redeem with a Vault flagged for premium redeem,
     * they can earn a DOT premium, slashed from the Vault's collateral.
     */
    getPremiumRedeemFee(): Promise<string>;
    /**
     * @returns The time difference in number of blocks between when a redeem request is created
     * and required completion time by a user.
     */
    getRedeemPeriod(): Promise<BlockNumber>;
    /**
     * Burn wrapped tokens for a premium
     * @param amount The amount of PolkaBTC to burn, denominated as PolkaBTC
     */
    burn(amount: Big): Promise<void>;
    /**
     * @returns The maximum amount of tokens that can be burned through a liquidation redeem
     */
    getMaxBurnableTokens(): Promise<Big>;
    /**
     * @returns The exchange rate (collateral currency to wrapped token currency)
     * used when burning tokens
     */
    getBurnExchangeRate(): Promise<Big>;
}

export class DefaultRedeemAPI {
    private vaultsAPI: VaultsAPI;
    private collateralAPI: CollateralAPI;
    requestHash: Hash = this.api.createType("Hash");
    events: EventRecord[] = [];
    transaction: Transaction;

    constructor(private api: ApiPromise, private btcNetwork: Network, private account?: AddressOrPair) {
        this.vaultsAPI = new DefaultVaultsAPI(api, btcNetwork, account);
        this.collateralAPI = new DefaultCollateralAPI(api, account);
        this.transaction = new Transaction(api);
    }

    private getRedeemIdsFromEvents(events: EventRecord[]): Hash[] {
        return getRequestIdsFromEvents(events, this.api.events.redeem.RequestRedeem, this.api);
    }

    async request(amountSat: BN, btcAddressEnc: string, options?: RequestOptions): Promise<RequestResult[]> {
        if (!this.account) {
            return Promise.reject(ACCOUNT_NOT_SET_ERROR_MESSAGE);
        }

        try {
            const availableVaults = options?.availableVaults || await this.vaultsAPI.getVaultsWithIssuableTokens();
            const atomic = !!options?.atomic;
            const retries = options?.retries || 0;
            const amountsPerVault = allocateAmountsToVaults(availableVaults, amountSat);
            const result = await this.requestAdvanced(amountsPerVault, btcAddressEnc, atomic);
            const successfulSum = result.reduce((sum, req) => sum.add(req.redeemRequest.amount_btc), new BN(0));
            const remainder = amountSat.sub(successfulSum);
            if (remainder.eqn(0) || retries === 0) return result;
            else {
                return (await this.request(remainder, btcAddressEnc, {availableVaults, atomic, retries: retries - 1})).concat(result);
            }
        } catch (e) {
            return Promise.reject(e.message);
        }
    }

    async requestAdvanced(
        amountsPerVault: Map<AccountId, BN>,
        btcAddressEnc: string,
        atomic: boolean
    ): Promise<RequestResult[]> {
        if (!this.account) {
            return Promise.reject(ACCOUNT_NOT_SET_ERROR_MESSAGE);
        }

        const btcAddress = this.api.createType("BtcAddress", decodeBtcAddress(btcAddressEnc, this.btcNetwork));
        const txes = new Array<SubmittableExtrinsic<"promise">>();
        for (const [vault, amount] of amountsPerVault) {
            txes.push(this.api.tx.redeem.requestRedeem(amount, btcAddress, vault));
        }
        const batch = (atomic ? this.api.tx.utility.batchAll : this.api.tx.utility.batch)(txes);
        try {
            const result = await this.transaction.sendLogged(batch, this.account, this.api.events.issue.RequestIssue);
            const ids = this.getRedeemIdsFromEvents(result.events);
            const redeemRequests = await this.getRequestsById(ids);
            return ids.map((id, idx) => ({ id, redeemRequest: redeemRequests[idx] }));
        } catch (e) {
            return Promise.reject(e.message);
        }
    }

    async execute(redeemId: H256, txId: H256Le, merkleProof: Bytes, rawTx: Bytes): Promise<boolean> {
        if (!this.account) {
            throw new Error("cannot execute without setting account");
        }
        const executeRedeemTx = this.api.tx.redeem.executeRedeem(redeemId, txId, merkleProof, rawTx);
        const result = await this.transaction.sendLogged(
            executeRedeemTx,
            this.account,
            this.api.events.redeem.ExecuteRedeem
        );
        const ids = this.getRedeemIdsFromEvents(result.events);
        if (ids.length > 1) {
            throw new Error("Unexpected multiple redeem events from single execute transaction!");
        }
        else if (ids.length === 1) {
            return true;
        }
        return false;
    }

    async cancel(redeemId: H256, reimburse?: boolean): Promise<void> {
        if (!this.account) {
            return Promise.reject(ACCOUNT_NOT_SET_ERROR_MESSAGE);
        }
        const reimburseValue = reimburse ? reimburse : false;
        const cancelRedeemTx = this.api.tx.redeem.cancelRedeem(redeemId, reimburseValue);
        await this.transaction.sendLogged(cancelRedeemTx, this.account, this.api.events.redeem.CancelRedeem);
    }

    async burn(amount: Big): Promise<void> {
        if (!this.account) {
            return Promise.reject(ACCOUNT_NOT_SET_ERROR_MESSAGE);
        }
        const amountSat = this.api.createType("Balance", btcToSat(amount.toString()));
        const burnRedeemTx = this.api.tx.redeem.liquidationRedeem(amountSat);
        await this.transaction.sendLogged(burnRedeemTx, this.account, this.api.events.redeem.LiquidationRedeem);
    }

    async getMaxBurnableTokens(): Promise<Big> {
        const liquidationVault = await this.vaultsAPI.getLiquidationVault();
        return new Big(satToBTC(liquidationVault.issued_tokens.toString()));
    }

    async getBurnExchangeRate(): Promise<Big> {
        const liquidationVault = await this.vaultsAPI.getLiquidationVault();
        const wrappedSatoshi = liquidationVault.issued_tokens.add(liquidationVault.to_be_issued_tokens);
        if(wrappedSatoshi.isZero()) {
            return Promise.reject("There are no burnable tokens. The burn exchange rate is undefined");
        }
        const wrappedBtc = new Big(satToBTC(wrappedSatoshi.toString()));
        const collateralPlanck = await this.collateralAPI.balanceLocked(liquidationVault.id);
        const collateralDot = new Big(planckToDOT(collateralPlanck.toString()));
        return collateralDot.div(wrappedBtc);
    }

    async list(): Promise<RedeemRequestExt[]> {
        const head = await this.api.rpc.chain.getFinalizedHead();
        const redeemRequests = await this.api.query.redeem.redeemRequests.entriesAt(head);
        return redeemRequests.map((v) => encodeRedeemRequest(v[1], this.btcNetwork));
    }

    async mapForUser(account: AccountId): Promise<Map<H256, RedeemRequestExt>> {
        const redeemRequestPairs: [H256, RedeemRequest][] = await this.api.rpc.redeem.getRedeemRequests(account);
        const mapForUser: Map<H256, RedeemRequestExt> = new Map<H256, RedeemRequestExt>();
        redeemRequestPairs.forEach((redeemRequestPair) =>
            mapForUser.set(redeemRequestPair[0], encodeRedeemRequest(redeemRequestPair[1], this.btcNetwork))
        );
        return mapForUser;
    }

    async subscribeToRedeemExpiry(account: AccountId, callback: (requestRedeemId: H256) => void): Promise<() => void> {
        const expired = new Set();
        try {
            const unsubscribe = await this.api.rpc.chain.subscribeFinalizedHeads(async (header: Header) => {
                const redeemRequests = await this.mapForUser(account);
                const redeemPeriod = await this.getRedeemPeriod();
                const currentParachainBlockHeight = header.number.toBn();
                redeemRequests.forEach((request, id) => {
                    if (request.opentime.add(redeemPeriod).lte(currentParachainBlockHeight) && !expired.has(id)) {
                        expired.add(id);
                        callback(this.api.createType("H256", stripHexPrefix(id.toString())));
                    }
                });
            });
            return unsubscribe;
        } catch (error) {
            console.log(`Error during expired redeem callback: ${error}`);
        }
        // as a fallback, return an empty void function
        return () => {
            return;
        };
    }

    async getFeesToPay(amount: string): Promise<string> {
        const feePercentage = await this.getFeeRate();
        const amountBig = new Big(amount);
        return amountBig.mul(feePercentage).toString();
    }

    async getFeeRate(): Promise<Big> {
        const head = await this.api.rpc.chain.getFinalizedHead();
        const redeemFee = await this.api.query.fee.redeemFee.at(head);
        return new Big(decodeFixedPointType(redeemFee));
    }

    async getRedeemPeriod(): Promise<BlockNumber> {
        const head = await this.api.rpc.chain.getFinalizedHead();
        return await this.api.query.redeem.redeemPeriod.at(head);
    }

    async getDustValue(): Promise<PolkaBTC> {
        const head = await this.api.rpc.chain.getFinalizedHead();
        return await this.api.query.redeem.redeemBtcDustValue.at(head);
    }

    async getPremiumRedeemFee(): Promise<string> {
        const head = await this.api.rpc.chain.getFinalizedHead();
        const premiumRedeemFee = await this.api.query.fee.premiumRedeemFee.at(head);
        return decodeFixedPointType(premiumRedeemFee);
    }

    getPagedIterator(perPage: number): AsyncGenerator<RedeemRequest[]> {
        return pagedIterator<RedeemRequest>(this.api.query.redeem.redeemRequests, perPage);
    }

    async getRequestById(redeemId: H256): Promise<RedeemRequestExt> {
        return (await this.getRequestsById([redeemId]))[0];
    }

    async getRequestsById(redeemIds: H256[]): Promise<RedeemRequestExt[]> {
        const head = await this.api.rpc.chain.getFinalizedHead();
        return Promise.all(
            redeemIds.map(async (redeemId) =>
                encodeRedeemRequest(await this.api.query.redeem.redeemRequests.at(head, redeemId), this.btcNetwork)
            )
        );
    }

    setAccount(account: AddressOrPair): void {
        this.account = account;
    }
}
