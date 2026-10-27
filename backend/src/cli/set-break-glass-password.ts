import { BreakGlassPasswordService } from '../auth/break-glass-password.service';
import { getBreakGlassOwnerEmails } from '../common/auth-config';
import { readSecret } from './read-secret';
import { runSetBreakGlassPassword } from './set-break-glass-password.command';
import { processIo, runCli } from './run-cli';

// npm run auth:set-break-glass-password -- <email>   （密碼從 stdin 讀）
void runCli((app) => {
  const service = app.get(BreakGlassPasswordService);
  const listed = getBreakGlassOwnerEmails();
  return runSetBreakGlassPassword(process.argv.slice(2), {
    ...processIo,
    setPassword: (email, password) => service.setPassword(email, password),
    readSecret: (prompt) => readSecret(prompt, process.stdin, process.stderr),
    interactive: !!process.stdin.isTTY,
    isListed: (email) => listed.includes(email.trim().toLowerCase()),
  });
});
