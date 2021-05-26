import { ApiPromise } from "@polkadot/api";
import { H256, AccountId } from "@polkadot/types/interfaces";
import { BlockNumber } from "@polkadot/types/interfaces/runtime";
import { Hash } from "@polkadot/types/interfaces";
import { AddressOrPair } from "@polkadot/api/types";
import { EventRecord } from "@polkadot/types/interfaces/system";
import Big from "big.js";
import { Network } from "bitcoinjs-lib";
import { Bytes } from "@polkadot/types";

import { ReplaceRequest } from "../interfaces/default";
import { dotToPlanck, encodeBtcAddress, satToBTC, storageKeyToFirstInner } from "../utils";
import { DefaultFeeAPI, FeeAPI } from "./fee";
import { DefaultTransactionAPI, TransactionAPI } from "./transaction";
import { btcToSat, ElectrsAPI, getTxProof } from "..";

export interface ReplaceRequestExt extends Omit<ReplaceRequest, "btc_address" | "new_vault"> {
    // network encoded btc address
    btc_address: string;
    new_vault: string;
}

export function encodeReplaceRequest(req: ReplaceRequest, network: Network): ReplaceRequestExt {
    let displayedBtcAddress = "Pending...";
    let displayedNewVaultAddress = "Pending...";
    displayedBtcAddress = encodeBtcAddress(req.btc_address, network);
    displayedNewVaultAddress = req.new_vault.toHuman();
    return ({
        ...req,
        btc_address: displayedBtcAddress,
        new_vault: displayedNewVaultAddress,
    } as unknown) as ReplaceRequestExt;
}

/**
 * @category PolkaBTC Bridge
 * The type Big represents DOT or PolkaBTC denominations,
 * while the type BN represents Planck or Satoshi denominations.
 */
export interface ReplaceAPI extends TransactionAPI {
    /**
     * @returns The minimum amount of btc that is accepted for replace requests; any lower values would
     * risk the bitcoin client to reject the payment
     */
    getBtcDustValue(): Promise<Big>;
    /**
     * @returns The time difference in number of blocks between when a replace request is created
     * and required completion time by a vault. The replace period has an upper limit
     * to prevent griefing of vault collateral.
     */
    getReplacePeriod(): Promise<BlockNumber>;
    /**
     * @returns An array containing the replace requests
     */
    list(): Promise<ReplaceRequestExt[]>;
    /**
     * @returns A mapping from the replace request ID to the replace request object
     */
    map(): Promise<Map<H256, ReplaceRequestExt>>;
    /**
     * @param amount Amount issued, denoted in Bitcoin, to have replaced by another vault
     * @returns The request id
     */
    request(amount: Big): Promise<string>;
    /**
     * Set an account to use when sending transactions from this API
     * @param account Keyring account
     */
    setAccount(account: AddressOrPair): void;
    /**
     * Wihdraw a replace request
     * @param amount The amount of wrapped tokens to withdraw from the amount
     * requested to have replaced.
     */
    withdraw(amount: Big): Promise<void>;
    /**
     * Accept a replace request
     * @param oldVault ID of the old vault that to be (possibly partially) replaced
     * @param amount Amount of issued tokens to be replaced
     * @param collateral The collateral for replacement
     * @param btcAddress The address that old-vault should transfer the btc to
     */
    accept(oldVault: AccountId, amountSat: Big, collateral: Big, btcAddress: string): Promise<void>;
    /**
     * Execute a replace request
     * @remarks If `txId` is not set, the `merkleProof` and `rawTx` must both be set.
     * 
     * @param replaceId The ID generated by the replace request transaction
     * @param txId (Optional) The ID of the Bitcoin transaction that sends funds from the old vault to the new vault
     * @param merkleProof (Optional) The merkle inclusion proof of the Bitcoin transaction. 
     * @param rawTx (Optional) The raw bytes of the Bitcoin transaction
     */
    execute(replaceId: string, btcTxId?: string, merkleProof?: Bytes, rawTx?: Bytes): Promise<void>;
}

export class DefaultReplaceAPI extends DefaultTransactionAPI implements ReplaceAPI {
    private btcNetwork: Network;
    private feeAPI: FeeAPI;

    constructor(api: ApiPromise, btcNetwork: Network, private electrsAPI: ElectrsAPI, account?: AddressOrPair) {
        super(api, account);
        this.btcNetwork = btcNetwork;
        this.feeAPI = new DefaultFeeAPI(api);
    }

    /**
     * @param events The EventRecord array returned after sending a replace request transaction
     * @returns The id associated with the replace request. If the EventRecord array does not
     * contain replace request events, the function throws an error.
     */
    private getRequestIdFromEvents(events: EventRecord[]): Hash {
        for (const { event } of events) {
            if (this.api.events.replace.RequestReplace.is(event)) {
                const hash = this.api.createType("Hash", event.data[0]);
                return hash;
            }
        }
        throw new Error("Request transaction failed");
    }

    async request(amount: Big): Promise<string> {
        const amountSat = this.api.createType("Wrapped", btcToSat(amount.toString()));
        const griefingCollateral = await this.getGriefingCollateral(amount);
        const requestTx = this.api.tx.replace.requestReplace(amountSat, btcToSat(griefingCollateral.toString()));
        const result = await this.sendLogged(requestTx, this.api.events.replace.RequestReplace);
        try {
            return this.getRequestIdFromEvents(result.events).toString();
        } catch (e) {
            return Promise.reject(e.message);
        }
    }

    async withdraw(amount: Big): Promise<void> {
        const amountSat = this.api.createType("Wrapped", btcToSat(amount.toString()));
        const requestTx = this.api.tx.replace.withdrawReplace(amountSat);
        await this.sendLogged(requestTx, this.api.events.replace.WithdrawReplace);
    }

    async accept(oldVault: AccountId, amount: Big, collateral: Big, btcAddress: string): Promise<void> {
        const parsedBtcAddress = this.api.createType("BtcAddress", btcAddress);
        const amountSat = this.api.createType("Wrapped", btcToSat(amount.toString()));
        const collateralPlanck = this.api.createType("Collateral", dotToPlanck(collateral.toString()));
        const requestTx = this.api.tx.replace.acceptReplace(oldVault, amountSat, collateralPlanck, parsedBtcAddress);
        await this.sendLogged(requestTx, this.api.events.replace.AcceptReplace);
    }

    async execute(requestId: string, btcTxId?: string, merkleProof?: Bytes, rawTx?: Bytes): Promise<void> {
        const parsedRequestId = this.api.createType("H256", "0x" + requestId);
        [merkleProof, rawTx] = await getTxProof(this.electrsAPI, btcTxId, merkleProof, rawTx);
        const requestTx = this.api.tx.replace.executeReplace(parsedRequestId, merkleProof, rawTx);
        await this.sendLogged(requestTx, this.api.events.replace.ExecuteReplace);
    }

    async getBtcDustValue(): Promise<Big> {
        const head = await this.api.rpc.chain.getFinalizedHead();
        const dustSatoshi = await this.api.query.replace.replaceBtcDustValue.at(head);
        return new Big(satToBTC(dustSatoshi.toString()));
    }

    async getGriefingCollateral(amount: Big): Promise<Big> {
        const griefingCollateralRate = await this.feeAPI.getReplaceGriefingCollateralRate();
        return await this.feeAPI.getGriefingCollateral(amount, griefingCollateralRate);
    }

    async getReplacePeriod(): Promise<BlockNumber> {
        const head = await this.api.rpc.chain.getFinalizedHead();
        return await this.api.query.replace.replacePeriod.at(head);
    }

    async list(): Promise<ReplaceRequestExt[]> {
        const head = await this.api.rpc.chain.getFinalizedHead();
        const replaceRequests = await this.api.query.replace.replaceRequests.entriesAt(head);
        return replaceRequests
            .map((v) => encodeReplaceRequest(v[1], this.btcNetwork));
    }

    async map(): Promise<Map<H256, ReplaceRequestExt>> {
        const head = await this.api.rpc.chain.getFinalizedHead();
        const redeemRequests = await this.api.query.replace.replaceRequests.entriesAt(head);
        const redeemRequestMap = new Map<H256, ReplaceRequestExt>();
        redeemRequests
            .forEach((v) => {
                redeemRequestMap.set(storageKeyToFirstInner(v[0]), encodeReplaceRequest(v[1], this.btcNetwork));
            });
        return redeemRequestMap;
    }

}
