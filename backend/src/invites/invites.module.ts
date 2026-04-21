import { Module } from '@nestjs/common';
import {
  InviteAcceptController,
  WorkspaceInvitesController,
} from './invites.controller';
import { InvitesService } from './invites.service';

@Module({
  controllers: [WorkspaceInvitesController, InviteAcceptController],
  providers: [InvitesService],
  exports: [InvitesService],
})
export class InvitesModule {}
