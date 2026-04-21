import { ForbiddenException } from '@nestjs/common';
import { PageAccessService, Access } from './page-access.service';

/**
 * PageAccessService 單元測試 —— 以 mock Prisma 驗證 resolve() 的核心規則：
 * admin/owner 逃生口、creator 不被鎖、visibility 預設、明確 permission、父頁繼承。
 */

type Page = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  createdById: string;
  visibility: 'workspace' | 'private' | 'restricted';
  inheritParentAcl: boolean;
  deletedAt: null | Date;
};

type Permission = {
  id: string;
  pageId: string;
  userId: string | null;
  role: string | null;
  access: Access;
};

type Member = { workspaceId: string; userId: string; role: string };

/** 建立一個能被 PageAccessService 當作 PrismaService 使用的最小 mock。 */
function makePrisma(state: { pages: Page[]; perms: Permission[]; members: Member[] }) {
  return {
    knowledgePage: {
      findUnique: async ({ where, select }: any) => {
        const p = state.pages.find((x) => x.id === where.id);
        if (!p) return null;
        // resolve() 用 `where: {id, deletedAt: null}` 的樣式並非 Prisma 的真實語法，
        // service 中目前是 where:{ id } + 後續用 p.deletedAt 判斷；本 mock 只回全物件
        return p;
      },
    },
    workspaceMember: {
      findUnique: async ({ where }: any) => {
        const { workspaceId, userId } = where.workspaceId_userId;
        return state.members.find((m) => m.workspaceId === workspaceId && m.userId === userId) ?? null;
      },
    },
    pagePermission: {
      findFirst: async ({ where }: any) => {
        const { pageId, OR } = where;
        const [byUser, byRole] = OR as [{ userId: string }, { role: string }];
        return (
          state.perms.find(
            (p) => p.pageId === pageId && (p.userId === byUser.userId || p.role === byRole.role),
          ) ?? null
        );
      },
    },
  } as any;
}

const WS = 'ws-1';

const baseMembers: Member[] = [
  { workspaceId: WS, userId: 'owner', role: 'owner' },
  { workspaceId: WS, userId: 'admin', role: 'admin' },
  { workspaceId: WS, userId: 'hr', role: 'hr' },
  { workspaceId: WS, userId: 'alice', role: 'member' },
  { workspaceId: WS, userId: 'bob', role: 'member' },
];

/** 做個空白 Page；各測試再覆寫自己需要的欄位 */
function page(overrides: Partial<Page>): Page {
  return {
    id: 'p',
    workspaceId: WS,
    parentId: null,
    createdById: 'alice',
    visibility: 'workspace',
    inheritParentAcl: true,
    deletedAt: null,
    ...overrides,
  };
}

function makeService(state: { pages: Page[]; perms: Permission[]; members: Member[] }) {
  return new PageAccessService(makePrisma(state));
}

describe('PageAccessService.resolve', () => {
  it('non-member 回傳 null', async () => {
    const svc = makeService({
      pages: [page({ id: 'p1' })],
      perms: [],
      members: baseMembers,
    });
    expect(await svc.resolve('stranger', 'p1')).toBeNull();
  });

  it('workspace owner 永遠是 full（即使 visibility=private 且無 perm）', async () => {
    const svc = makeService({
      pages: [page({ id: 'p1', visibility: 'private', createdById: 'alice' })],
      perms: [],
      members: baseMembers,
    });
    expect(await svc.resolve('owner', 'p1')).toBe('full');
  });

  it('workspace admin 永遠是 full', async () => {
    const svc = makeService({
      pages: [page({ id: 'p1', visibility: 'private', createdById: 'alice' })],
      perms: [],
      members: baseMembers,
    });
    expect(await svc.resolve('admin', 'p1')).toBe('full');
  });

  it('creator 即使 visibility=private 也永遠 full（不會被鎖在外）', async () => {
    const svc = makeService({
      pages: [page({ id: 'p1', visibility: 'private', createdById: 'alice' })],
      perms: [],
      members: baseMembers,
    });
    expect(await svc.resolve('alice', 'p1')).toBe('full');
  });

  it('visibility=workspace → 普通成員預設 edit', async () => {
    const svc = makeService({
      pages: [page({ id: 'p1', visibility: 'workspace', createdById: 'alice' })],
      perms: [],
      members: baseMembers,
    });
    expect(await svc.resolve('bob', 'p1')).toBe('edit');
  });

  it('visibility=private + 無 perm + 非 creator → null', async () => {
    const svc = makeService({
      pages: [page({ id: 'p1', visibility: 'private', createdById: 'alice' })],
      perms: [],
      members: baseMembers,
    });
    expect(await svc.resolve('bob', 'p1')).toBeNull();
  });

  it('visibility=restricted + 對 userId 明確給 view → view', async () => {
    const svc = makeService({
      pages: [page({ id: 'p1', visibility: 'restricted', createdById: 'alice' })],
      perms: [{ id: 'perm-1', pageId: 'p1', userId: 'bob', role: null, access: 'view' }],
      members: baseMembers,
    });
    expect(await svc.resolve('bob', 'p1')).toBe('view');
  });

  it('visibility=restricted + 對 role=hr 給 view → 該 role user 取得 view', async () => {
    const svc = makeService({
      pages: [page({ id: 'p1', visibility: 'restricted', createdById: 'alice' })],
      perms: [{ id: 'perm-1', pageId: 'p1', userId: null, role: 'hr', access: 'view' }],
      members: baseMembers,
    });
    expect(await svc.resolve('hr', 'p1')).toBe('view');
    // 非 hr 的普通成員無 perm 命中 → null
    expect(await svc.resolve('bob', 'p1')).toBeNull();
  });

  it('子頁 inheritParentAcl=true 時，父頁的 perm 會被繼承', async () => {
    const parent = page({ id: 'parent', visibility: 'restricted', createdById: 'alice' });
    const child = page({
      id: 'child',
      parentId: 'parent',
      visibility: 'restricted',
      inheritParentAcl: true,
      createdById: 'alice',
    });
    const svc = makeService({
      pages: [parent, child],
      perms: [
        { id: 'perm-1', pageId: 'parent', userId: 'bob', role: null, access: 'edit' },
      ],
      members: baseMembers,
    });
    // bob 對子頁沒直接 perm，但父頁給他 edit → 子頁也繼承
    expect(await svc.resolve('bob', 'child')).toBe('edit');
  });

  it('子頁 inheritParentAcl=false 時不繼承父頁（即使父頁有 perm 也拒）', async () => {
    const parent = page({ id: 'parent', visibility: 'restricted', createdById: 'alice' });
    const child = page({
      id: 'child',
      parentId: 'parent',
      visibility: 'restricted',
      inheritParentAcl: false,
      createdById: 'alice',
    });
    const svc = makeService({
      pages: [parent, child],
      perms: [{ id: 'perm-1', pageId: 'parent', userId: 'bob', role: null, access: 'edit' }],
      members: baseMembers,
    });
    expect(await svc.resolve('bob', 'child')).toBeNull();
  });

  it('子頁自己的 perm 優先於父頁（子頁 view 覆蓋父頁 edit）', async () => {
    const parent = page({ id: 'parent', visibility: 'restricted', createdById: 'alice' });
    const child = page({
      id: 'child',
      parentId: 'parent',
      visibility: 'restricted',
      inheritParentAcl: true,
      createdById: 'alice',
    });
    const svc = makeService({
      pages: [parent, child],
      perms: [
        { id: 'perm-1', pageId: 'parent', userId: 'bob', role: null, access: 'edit' },
        { id: 'perm-2', pageId: 'child', userId: 'bob', role: null, access: 'view' },
      ],
      members: baseMembers,
    });
    expect(await svc.resolve('bob', 'child')).toBe('view');
  });

  it('孫頁 → 子頁(inherit) → 父頁(有 perm) 的繼承鏈可跨多層', async () => {
    const grand = page({ id: 'grand', visibility: 'restricted', createdById: 'alice' });
    const parent = page({
      id: 'parent',
      parentId: 'grand',
      visibility: 'restricted',
      inheritParentAcl: true,
      createdById: 'alice',
    });
    const child = page({
      id: 'child',
      parentId: 'parent',
      visibility: 'restricted',
      inheritParentAcl: true,
      createdById: 'alice',
    });
    const svc = makeService({
      pages: [grand, parent, child],
      perms: [{ id: 'perm-1', pageId: 'grand', userId: 'bob', role: null, access: 'full' }],
      members: baseMembers,
    });
    expect(await svc.resolve('bob', 'child')).toBe('full');
  });

  it('visibility=workspace 在繼承鏈中會提前終止（不再往上找）', async () => {
    // 父頁 restricted 有 perm，子頁 workspace → 子頁在 visibility 層就決定 edit，不繼承父頁 full
    const parent = page({ id: 'parent', visibility: 'restricted', createdById: 'alice' });
    const child = page({
      id: 'child',
      parentId: 'parent',
      visibility: 'workspace',
      inheritParentAcl: true,
      createdById: 'alice',
    });
    const svc = makeService({
      pages: [parent, child],
      perms: [{ id: 'perm-1', pageId: 'parent', userId: 'bob', role: null, access: 'full' }],
      members: baseMembers,
    });
    expect(await svc.resolve('bob', 'child')).toBe('edit');
  });
});

describe('PageAccessService.assertAtLeast', () => {
  it('有 edit 要求 view 通過', async () => {
    const svc = makeService({
      pages: [page({ id: 'p1', visibility: 'workspace', createdById: 'alice' })],
      perms: [],
      members: baseMembers,
    });
    await expect(svc.assertAtLeast('bob', 'p1', 'view')).resolves.toBe('edit');
  });

  it('有 view 要求 edit 被拒', async () => {
    const svc = makeService({
      pages: [page({ id: 'p1', visibility: 'restricted', createdById: 'alice' })],
      perms: [{ id: 'perm-1', pageId: 'p1', userId: 'bob', role: null, access: 'view' }],
      members: baseMembers,
    });
    await expect(svc.assertAtLeast('bob', 'p1', 'edit')).rejects.toThrow(ForbiddenException);
  });

  it('完全無權限時拒絕', async () => {
    const svc = makeService({
      pages: [page({ id: 'p1', visibility: 'private', createdById: 'alice' })],
      perms: [],
      members: baseMembers,
    });
    await expect(svc.assertAtLeast('bob', 'p1', 'view')).rejects.toThrow(ForbiddenException);
  });
});
