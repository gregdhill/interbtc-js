import { ApiPromise } from "@polkadot/api";
import { AccountId, H256 } from "@polkadot/types/interfaces";
import { Network } from "bitcoinjs-lib";
import { Bytes } from "@polkadot/types";
import { AddressOrPair } from "@polkadot/api/types";

import { RefundRequest } from "../interfaces";
import { ensureHashEncoded, getTxProof, parseRefundRequest } from "../utils";
import { ElectrsAPI } from "../external";
import { DefaultTransactionAPI, TransactionAPI } from "./transaction";
import { RefundRequestExt } from "../types/requestTypes";

/**
 * @category InterBTC Bridge
 */
export interface RefundAPI extends TransactionAPI {
    /**
     * Execute a refund request
     * @remarks If `txId` is not set, the `merkleProof` and `rawTx` must both be set.
     *
     * @param refundId The ID generated by the refund request transaction
     * @param txId (Optional) The ID of the Bitcoin transaction that refunds a user in case of overpayment
     * @param merkleProof (Optional) The merkle inclusion proof of the Bitcoin transaction.
     * @param rawTx (Optional) The raw bytes of the Bitcoin transaction
     */
    execute(refundId: string, btcTxId?: string, merkleProof?: Bytes, rawTx?: Bytes): Promise<void>;
    /**
     * @returns An array containing the refund requests
     */
    list(): Promise<RefundRequestExt[]>;
    /**
     * @param account The ID of the account whose refund requests are to be retrieved
     * @returns A mapping from the refund ID to the refund request, corresponding to the given account
     */
    mapForUser(account: AccountId): Promise<Map<H256, RefundRequestExt>>;
    /**
     * @param issueId The ID of the refund to fetch
     * @returns A refund object
     */
    getRequestById(refundId: H256): Promise<RefundRequestExt>;
    /**
     * @param issueId The ID of the refund request to fetch
     * @returns A refund request object
     */
    getRequestByIssueId(issueId: H256 | string): Promise<RefundRequestExt>;
    /**
     * @param issueId The ID of the refund request to fetch
     * @returns The ID of the refund request
     */
    getRequestIdByIssueId(issueId: H256 | string): Promise<H256>;
}

export class DefaultRefundAPI extends DefaultTransactionAPI implements RefundAPI {
    constructor(api: ApiPromise, private btcNetwork: Network, private electrsAPI: ElectrsAPI, account?: AddressOrPair) {
        super(api, account);
    }

    async execute(requestId: string, btcTxId?: string, merkleProof?: Bytes, rawTx?: Bytes): Promise<void> {
        const parsedRequestId = this.api.createType("H256", "0x" + requestId);
        [merkleProof, rawTx] = await getTxProof(this.electrsAPI, btcTxId, merkleProof, rawTx);
        const requestTx = this.api.tx.refund.executeRefund(parsedRequestId, merkleProof, rawTx);
        await this.sendLogged(requestTx, this.api.events.refund.ExecuteRefund);
    }

    async list(): Promise<RefundRequestExt[]> {
        const head = await this.api.rpc.chain.getFinalizedHead();
        const refundRequests = await this.api.query.refund.refundRequests.entriesAt(head);
        return refundRequests.map((v) => parseRefundRequest(v[1], this.btcNetwork));
    }

    async mapForUser(account: AccountId): Promise<Map<H256, RefundRequestExt>> {
        const refundPairs: [H256, RefundRequest][] = await this.api.rpc.refund.getRefundRequests(account);
        const mapForUser: Map<H256, RefundRequestExt> = new Map<H256, RefundRequestExt>();
        refundPairs.forEach((refundPair) =>
            mapForUser.set(refundPair[0], parseRefundRequest(refundPair[1], this.btcNetwork))
        );
        return mapForUser;
    }

    async getRequestById(refundId: H256): Promise<RefundRequestExt> {
        const head = await this.api.rpc.chain.getFinalizedHead();
        return parseRefundRequest(await this.api.query.refund.refundRequests.at(head, refundId), this.btcNetwork);
    }

    async getRequestIdByIssueId(issueId: H256 | string): Promise<H256> {
        try {
            const id = ensureHashEncoded(this.api, issueId);
            const keyValuePair = await this.api.rpc.refund.getRefundRequestsByIssueId(id);
            return keyValuePair[0];
        } catch (error) {
            return Promise.reject(new Error(`Error fetching refund request by issue id: ${error}`));
        }
    }

    async getRequestByIssueId(issueId: H256 | string): Promise<RefundRequestExt> {
        try {
            const id = ensureHashEncoded(this.api, issueId);
            const keyValuePair = await this.api.rpc.refund.getRefundRequestsByIssueId(id);
            return parseRefundRequest(keyValuePair[1], this.btcNetwork);
        } catch (error) {
            return Promise.reject(new Error(`Error fetching refund request by issue id: ${error}`));
        }
    }
}
