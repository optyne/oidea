import { Injectable } from '@nestjs/common';

/** 只需要能斷線的最小 socket 介面（方便測試）。 */
export interface DisconnectableSocket {
  id: string;
  disconnect(close?: boolean): unknown;
}

/**
 * 記錄每位使用者目前的 socket 連線（所有 gateway／namespace 共用）。
 * H2 離職流程用 `disconnectUser()` 斷開某人的全部連線。
 *
 * 只記本程序的連線；之後若橫向擴充成多個 backend instance，要改成用 Redis 廣播斷線指令。
 */
@Injectable()
export class SocketRegistry {
  private readonly byUser = new Map<string, Set<DisconnectableSocket>>();

  add(userId: string, socket: DisconnectableSocket): void {
    let set = this.byUser.get(userId);
    if (!set) {
      set = new Set();
      this.byUser.set(userId, set);
    }
    set.add(socket);
  }

  remove(userId: string, socket: DisconnectableSocket): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.byUser.delete(userId);
  }

  count(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }

  /** 斷開某使用者的全部連線，回傳斷了幾條。 */
  disconnectUser(userId: string): number {
    const set = this.byUser.get(userId);
    if (!set) return 0;
    const sockets = [...set];
    this.byUser.delete(userId);
    for (const s of sockets) s.disconnect(true);
    return sockets.length;
  }
}
