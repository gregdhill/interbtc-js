# PolkaBTC JS

JavaScript library to interact with PolkaBTC

## Getting started

See [BTC Parachain](https://github.com/interlay/btc-parachain) to get a development node running.

To install dependencies, run

```
yarn install
```

Build the library using

```
yarn build
```

Then, to run tests, run

```
yarn test
```

Note that the parachain needs to be running for all tests to pass.
To run only unit tests, use

```
yarn test:unit
```

## Usage

### Real PolkaBTC Queries

To use the library, you will first need to create a PolkadotJS `APIPromise` instance,
and then to instantiate a `PolkaBTCAPI` instance.

```typescript
import { PolkaBTCAPI, createAPI } from "@interlay/polkabtc";

const defaultEndpoint = "ws://127.0.0.1:9944";
const api = await createAPI(defaultEndpoint);
const polkaBTC = new PolkaBTCAPI(api);
```

To emit transactions, an `account` has to be set.
The account should be an instance of `KeyringPair`.

```typescript
import testKeyring from "@polkadot/keyring/testing";
const keyring = testKeyring();
const keypair = keypair.getPairs()[0];
polkaBTC.setAccount(keypair);
```

The different functionalities are then exposed through the `PolkaBTCAPI` instance.

### Mock PolkaBTC Queries

```typescript
import { PolkaBTCAPIMock } from "@interlay/polkabtc";

const polkaBTC = new PolkaBTCAPIMock();
```

Example usage:
```typescript
const issueRequests = await polkaBTC.issue.list();
const totalStakedDOTAmount = await polkaBTC.stakedRelayer.getTotalStakedDOTAmount();
```

Certain API calls require a parameter of type `AccountId`. For testing, an empty accountId will suffice:
```typescript
import { AccountId } from "@polkadot/types/interfaces/runtime";

const activeStakedRelayerId = <AccountId> {};
const feesEarnedByActiveStakedRelayer = await polkaBTC.stakedRelayer.getFeesEarned(activeStakedRelayerId);
```