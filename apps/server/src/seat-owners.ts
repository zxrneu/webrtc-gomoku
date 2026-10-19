interface ConnectionOwner { isRevoked: boolean }

/** 座位接管时永久撤销旧物理连接，权限不随座位释放而恢复。 */
export class SeatOwners {
  private readonly owners = new Map<string, ConnectionOwner>();

  claim(peerId: string, connection: ConnectionOwner): boolean {
    if (connection.isRevoked) return false;
    const previous = this.owners.get(peerId);
    if (previous && previous !== connection) previous.isRevoked = true;
    this.owners.set(peerId, connection);
    return true;
  }

  release(peerId: string): void { this.owners.delete(peerId); }
}
