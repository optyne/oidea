/** 測試用的 socket.io client 替身：記錄 join、自己收到的 emit、對房間廣播的 emit。 */
export class FakeWsClient {
  rooms = new Set<string>();
  data: Record<string, any>;
  emitted: Array<[string, unknown]> = [];
  broadcasts: Array<{ room: string; event: string; payload: unknown }> = [];

  constructor(userId: string) {
    this.data = { userId };
    this.rooms.add('self-id');
  }

  join(room: string) {
    this.rooms.add(room);
  }
  leave(room: string) {
    this.rooms.delete(room);
  }
  emit(event: string, payload?: unknown) {
    this.emitted.push([event, payload]);
    return true;
  }
  to(room: string) {
    return {
      emit: (event: string, payload?: unknown) => {
        this.broadcasts.push({ room, event, payload });
        return true;
      },
    };
  }
  disconnect() {}
}
