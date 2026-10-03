// Tạo ADMIN_PASSWORD_HASH (PBKDF2-SHA256) và SESSION_SECRET.
// Chạy: npm run hash-password
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import readline from 'node:readline';

const ITERATIONS = 100000; // Cloudflare Workers giới hạn tối đa 100000

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = () => {}; // không hiện ký tự đang gõ
    process.stdout.write(question);
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

let password = process.argv[2];
if (!password) {
  password = await askHidden('Nhập mật khẩu admin (không hiện khi gõ): ');
  const again = await askHidden('Nhập lại mật khẩu: ');
  if (password !== again) {
    console.error('Hai lần nhập không khớp.');
    process.exit(1);
  }
}
if (password.length < 10) {
  console.error('Mật khẩu nên có ít nhất 10 ký tự.');
  process.exit(1);
}

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const out = `pbkdf2:${ITERATIONS}:${salt.toString('base64url')}:${hash.toString('base64url')}`;

console.log('\nADMIN_PASSWORD_HASH=' + out);
console.log('SESSION_SECRET=' + randomBytes(32).toString('base64url'));
console.log('\nDán từng giá trị vào .dev.vars (local) hoặc `npx wrangler secret put <TÊN>` (production).');
