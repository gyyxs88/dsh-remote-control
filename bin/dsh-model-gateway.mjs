#!/usr/bin/env node
import { ModelGateway, NoProviderAdapter } from '../lib/gateway.mjs';
import { pathToFileURL } from 'node:url';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

async function loadProvider() {
  const modulePath = option('provider-module', null);
  if (!modulePath) return new NoProviderAdapter();
  const imported = await import(pathToFileURL(modulePath).href);
  const factory = imported.createProviderAdapter ?? imported.default;
  const provider = typeof factory === 'function' ? await factory() : factory;
  if (!provider || typeof provider.listModels !== 'function' || typeof provider.generate !== 'function') throw new Error('provider module must export createProviderAdapter() or a provider object');
  return provider;
}

const port = Number(option('port', '0'));
let gateway;
loadProvider().then((provider) => {
  gateway = new ModelGateway({ provider });
  return gateway.listen({ host: '127.0.0.1', port });
}).then((address) => {
  process.stderr.write(`dsh-model-gateway listening on ${address.endpoint}\n`);
}).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});

process.on('SIGTERM', () => void gateway?.close().then(() => process.exit(0)));
process.on('SIGINT', () => void gateway?.close().then(() => process.exit(0)));
