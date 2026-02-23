#!/usr/bin/env node
/**
 * MongoDB 연결 테스트
 * 실행: node scripts/test-mongo.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const URI = (process.env.REACT_APP_MONGODB_URI || process.env.MONGODB_URI || '').trim();
const { MongoClient } = require('mongodb');

async function main() {
  if (!URI || URI.includes('your_')) {
    console.error('❌ .env에 REACT_APP_MONGODB_URI 또는 MONGODB_URI가 없습니다.');
    process.exit(1);
  }
  let uri = URI;
  if (!uri.includes('retryWrites=')) uri += (uri.includes('?') ? '&' : '?') + 'retryWrites=true&w=majority';

  try {
    const client = await MongoClient.connect(uri, {
      serverSelectionTimeoutMS: 10000,
      autoSelectFamily: false,
    });
    await client.db('chatapp').command({ ping: 1 });
    await client.close();
    console.log('✅ MongoDB 연결 성공');
    process.exit(0);
  } catch (err) {
    console.error('❌ MongoDB 연결 실패:', err.message);
    if (err.message.includes('SSL') || err.message.includes('tls') || err.message.includes('alert')) {
      console.error('\n→ Atlas가 연결을 거부했습니다. Atlas 대시보드에서 확인하세요:');
      console.error('  1) Database Access → 해당 사용자 Edit → Edit Password → 새 비밀번호 설정 후 .env의 비밀번호와 동일하게');
      console.error('  2) Network Access → Add Current IP Address (또는 Allow access from anywhere)');
      console.error('  3) Cluster0가 있는 프로젝트(ChatApp MGT Gen AI)에서 설정했는지 확인');
    }
    process.exit(1);
  }
}

main();
