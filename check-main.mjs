import { createPgStores } from './src/pm/risk/src/money-kernel-pg.ts';
import { MoneyKernel } from '@polyroot/risk';

const stores = createPgStores({ connectionString: "postgresql://test:test@localhost:5432/test" });

console.log("stores.authority:", typeof stores.authority);
console.log("stores.balanceStore:", typeof stores.balanceStore);
console.log("stores.eventSink:", typeof stores.eventSink);

// Test MoneyKernel constructor
const kernel = new MoneyKernel({
  balance: stores.balanceStore,
  sink: stores.eventSink,
  authority: stores.authority,
  chainId: 137,
  mode: "PAPER",
});

console.log("MoneyKernel created successfully");
