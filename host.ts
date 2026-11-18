import { experimental_defineHostEntry } from '@get-bb/plugin-sdk';
import { hostContract } from './contract.ts';
import { collectSnapshot } from './reader.ts';
import { readDelegation, writeDelegation } from './delegation.ts';
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    collect: (input, context) => collectSnapshot(input, context.signal),
    delegation: input => readDelegation(input.root),
    setDelegation: input => writeDelegation(input.root, input.choice, input.role),
  },
});
