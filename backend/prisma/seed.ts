import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

/** 僅供本機開發；若已存在同信箱則略過。執行：npx prisma db seed */
async function main() {
  const email = 'dev@oidea.local';
  const password = 'oidea_dev_123';
  const username = 'dev';

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Seed 略過：使用者已存在 ${email}`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.create({
    data: {
      email,
      username,
      displayName: '開發測試帳號',
      passwordHash,
    },
  });

  console.log('已建立開發用帳號（請勿用於正式環境）：');
  console.log(`  信箱：${email}`);
  console.log(`  密碼：${password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
