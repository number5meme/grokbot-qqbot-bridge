#!/usr/bin/env node
'use strict';
// Interactive configuration: writes .env in this bridge folder (next to package.json).
const path = require('node:path');
const { COMMON_QUESTIONS, runSetup } = require('../src/setup-common');

const QQ_QUESTIONS = [
  { key: 'QQBOT_APP_ID', required: true, help: 'Bot AppID from q.qq.com (bot management page).' },
  { key: 'QQBOT_APP_SECRET', required: true, secret: true,
    help: 'Bot AppSecret from q.qq.com. It is shown only once; viewing it again resets it and the old one stops working.' },
];

runSetup({ questions: [...QQ_QUESTIONS, ...COMMON_QUESTIONS], file: path.join(__dirname, '..', '.env') })
  .then(() => console.log('Next: ./start.sh, then send the bot a message from your own QQ account.'))
  .catch((e) => { console.error(e.message); process.exit(1); });
