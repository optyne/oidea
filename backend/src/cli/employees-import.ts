import { readFile } from 'fs/promises';
import { EmployeesService } from '../employees/employees.service';
import { runEmployeesImport } from './employees-import.command';
import { processIo, runCli } from './run-cli';

// npm run employees:import -- <csv>
void runCli((app) => {
  const employees = app.get(EmployeesService);
  return runEmployeesImport(process.argv.slice(2), {
    ...processIo,
    readFile: (p) => readFile(p),
    importRows: (rows) => employees.importRows(rows, { actorId: null }),
  });
});
