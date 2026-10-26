import { CompanyInitService } from '../company/company-init.service';
import { runCompanyInit } from './company-init.command';
import { processIo, runCli } from './run-cli';

// npm run company:init -- --workspace <id>|--create <name> --owner-email <email> ...
void runCli((app) => {
  const service = app.get(CompanyInitService);
  return runCompanyInit(process.argv.slice(2), { ...processIo, init: (opts) => service.init(opts) });
});
