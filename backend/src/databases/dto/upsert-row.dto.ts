import { IsOptional, IsInt, IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpsertRowDto {
  @ApiProperty({
    description: '欄位 id → 值 的 map。值的型別依欄位 type。',
    example: { 'col-uuid-1': '合約 A', 'col-uuid-2': 60000 },
  })
  @IsObject()
  values: Record<string, unknown>;

  @ApiProperty({ required: false, default: 0 })
  @IsOptional()
  @IsInt()
  position?: number;
}
