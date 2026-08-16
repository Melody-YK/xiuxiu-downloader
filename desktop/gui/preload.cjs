// 预加载：向渲染层暴露最小 API（沙箱渲染器可用 require('electron') 的子集）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  addTask: (task) => ipcRenderer.invoke('task:add', task),
  cancelTask: (id) => ipcRenderer.invoke('task:cancel', id),
  openFolder: (p) => ipcRenderer.invoke('util:openFolder', p),
  chooseSavePath: (opts) => ipcRenderer.invoke('util:chooseSavePath', opts),
  getSnapshot: () => ipcRenderer.invoke('app:getSnapshot'),
  onTaskEvent: (cb) => ipcRenderer.on('task:event', (_e, ev) => cb(ev)),
  onCapture: (cb) => ipcRenderer.on('capture:new', (_e, entries) => cb(entries)),
});
