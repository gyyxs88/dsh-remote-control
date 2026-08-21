#!/usr/bin/env node
import { ModelGateway, NoProviderAdapter } from '../lib/gateway.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const gateway = new ModelGateway({ provider: new NoProviderAdapter() });
const port = Number(option('port', '0'));
gateway.listen({ host: '127.0.0.1', port }).then((address) => {
  process.stderr.write(`dsh-model-gateway listening on ${address.endpoint}\n`);
}).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});

process.on('SIGTERM', () => void gateway.close().then(() => process.exit(0)));
process.on('SIGINT', () => void gateway.close().then(() => process.exit(0)));
