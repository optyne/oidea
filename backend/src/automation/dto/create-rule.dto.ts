import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const AUTOMATION_SCOPES = ['project', 'database'] as const;
export type AutomationScope = (typeof AUTOMATION_SCOPES)[number];

export const AUTOMATION_TRIGGERS = [
  'task_completed',
  // 'task_moved_to_column', // 下一刀
  // 'row_status_changed',   // 下一刀
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const AUTOMATION_ACTIONS = [
  'notify_user',
  'post_to_channel',
] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

export class CreateAutomationRuleDto {
  @ApiProperty()
  @IsString()
  workspaceId: string;

  @ApiProperty({ example: '合約任務完成 → #財務' })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ enum: AUTOMATION_SCOPES })
  @IsIn(AUTOMATION_SCOPES as unknown as string[])
  scope: AutomationScope;

  @ApiProperty({ description: 'Project.id 或 Database.id' })
  @IsString()
  scopeId: string;

  @ApiProperty({ enum: AUTOMATION_TRIGGERS })
  @IsIn(AUTOMATION_TRIGGERS as unknown as string[])
  trigger: AutomationTrigger;

  @ApiProperty({
    required: false,
    description: 'trigger 附帶設定，例 { columnId: "..." }；目前 task_completed 不需',
  })
  @IsOptional()
  @IsObject()
  triggerConfig?: Record<string, unknown>;

  @ApiProperty({ enum: AUTOMATION_ACTIONS })
  @IsIn(AUTOMATION_ACTIONS as unknown as string[])
  action: AutomationAction;

  @ApiProperty({
    description:
      'action 設定；notify_user: { userId, title?, contentTemplate? }；' +
      'post_to_channel: { channelId, contentTemplate }',
  })
  @IsObject()
  actionConfig: Record<string, unknown>;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
