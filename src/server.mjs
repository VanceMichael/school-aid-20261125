// 业务应用入口。默认 4318 端口；PARTNER_URL 指向采购结款方（默认本机 4317）。
// APP_STATE 指定持久状态文件，默认 .local/app.json；停止后用同一状态文件启动可恢复。
import { readFileSync } from 'node:fs';
import { createApp } from './app.mjs';
import { createStore } from './store.mjs';
import { createPartnerClient } from './partner.mjs';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/records.json', import.meta.url), 'utf8'));
const partnerConfig = JSON.parse(readFileSync(new URL('../fixtures/partner.json', import.meta.url), 'utf8'));

const stateFile = process.env.APP_STATE ?? '.local/app.json';
const partnerUrl = process.env.PARTNER_URL ?? 'http://127.0.0.1:4317';

const store = createStore({ stateFile, fixtures });
const partner = createPartnerClient(partnerUrl, partnerConfig);
const server = createApp({ store, partner });

const port = Number(process.env.PORT ?? 4318);
server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ message: '业务应用已启动', port: server.address().port, stateFile, partnerUrl }));
});
