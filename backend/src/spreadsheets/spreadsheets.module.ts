import { Module } from '@nestjs/common';
import { SpreadsheetsController } from './spreadsheets.controller';
import { SpreadsheetsService } from './spreadsheets.service';

@Module({
  controllers: [SpreadsheetsController],
  providers: [SpreadsheetsService],
})
export class SpreadsheetsModule {}
