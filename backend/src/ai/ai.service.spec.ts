import { AiService } from './ai.service';

describe('AiService.buildChatMessages', () => {
  const BOT = 'bot-1';

  it('bot 的訊息 → assistant turn、原文；他人訊息 → user turn、帶 displayName 前綴', () => {
    const out = AiService.buildChatMessages(
      [
        { senderId: 'u-1', content: '早安 @ai', sender: { displayName: '小明' } },
        { senderId: BOT, content: '早安！', sender: { displayName: 'Oidea AI' } },
        { senderId: 'u-2', content: '幫我摘要', sender: { displayName: '阿華' } },
      ],
      BOT,
    );
    expect(out).toEqual([
      { role: 'user', content: '小明: 早安 @ai' },
      { role: 'assistant', content: '早安！' },
      { role: 'user', content: '阿華: 幫我摘要' },
    ]);
  });

  it('結尾是 assistant → 自動補一個 user turn', () => {
    const out = AiService.buildChatMessages([{ senderId: BOT, content: 'hi', sender: null }], BOT);
    expect(out[out.length - 1].role).toBe('user');
  });

  it('空輸入 → 只有補上的 user turn', () => {
    const out = AiService.buildChatMessages([], BOT);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
  });

  it('content 為 null → 空字串，不炸', () => {
    const out = AiService.buildChatMessages([{ senderId: 'u-1', content: null, sender: null }], BOT);
    expect(out[0].content).toBe('user: ');
  });
});
