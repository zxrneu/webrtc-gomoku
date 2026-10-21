'use strict';

/** 通过当前可见的大厅/房间操作建立测试会话，不依赖旧版空棋盘入口。 */
async function setName(page, name) {
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.locator('#lobby-name').fill(name);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('#lobby-panel').getByText(name, { exact: true }).waitFor();
}

async function createRoom(page) {
  await page.locator('#lobby-create:enabled').click();
  await page.waitForFunction(() => window.__gomoku.room.length === 4);
}

async function joinRoom(page, room) {
  await page.locator('#lobby-room-code').fill(room);
  await page.locator('#lobby-join-btn').click();
}

module.exports = { setName, createRoom, joinRoom };
