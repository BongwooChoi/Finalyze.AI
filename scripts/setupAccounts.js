require('dotenv').config();
const { getAccountStore } = require('../accountStore');
(async () => {
  const store = getAccountStore();
  await store.initialize();
  await store.close();
  console.log('계정 데이터베이스 준비 완료');
})().catch(() => {
  console.error('계정 데이터베이스를 준비하지 못했습니다. DATABASE_URL과 연결 상태를 확인해주세요.');
  process.exitCode = 1;
});
