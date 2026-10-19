import { describe, expect, it } from 'vitest';
import { SeatOwners } from '../src/seat-owners';

describe('物理连接的座位写权限', () => {
  it('接管座位时永久撤销旧连接权限', () => {
    const owners = new SeatOwners(); const old = { isRevoked: false }; const fresh = { isRevoked: false };
    owners.claim('peer', old); owners.claim('peer', fresh);
    expect(old.isRevoked).toBe(true); expect(fresh.isRevoked).toBe(false);
    owners.release('peer');
    expect(old.isRevoked).toBe(true);
  });
  it('同一连接重新登记不会撤销自己的权限', () => {
    const owners = new SeatOwners(); const connection = { isRevoked: false };
    owners.claim('peer', connection); owners.claim('peer', connection);
    expect(connection.isRevoked).toBe(false);
  });
  it('已撤权连接不能在座位释放后再次登记', () => {
    const owners = new SeatOwners(); const old = { isRevoked: false }; const fresh = { isRevoked: false };
    owners.claim('peer', old); owners.claim('peer', fresh); owners.release('peer');
    expect(owners.claim('peer', old)).toBe(false);
    expect(owners.claim('peer', fresh)).toBe(true);
    expect(fresh.isRevoked).toBe(false);
  });
});
