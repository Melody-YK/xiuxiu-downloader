// 预加载：向渲染层暴露最小 API（沙箱渲染器可用 require('electron') 的子集）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  addTask: (task) => ipcRenderer.invoke('task:add', task),
  cancelTask: (id) => ipcRenderer.invoke('task:cancel', id),
  pauseTask: (id) => ipcRenderer.invoke('task:pause', id),
  resumeTask: (id) => ipcRenderer.invoke('task:resume', id),
  closeClip: () => ipcRenderer.invoke('clip:close'),
  showMain: () => ipcRenderer.invoke('util:showMain'),
  removeTask: (id) => ipcRenderer.invoke('task:remove', id),
  removeTasks: (ids, withFiles) => ipcRenderer.invoke('task:removeMany', { ids, withFiles }),
  removeAllTasks: (withFiles) => ipcRenderer.invoke('task:removeAll', { withFiles }),
  removeAllCaptures: () => ipcRenderer.invoke('capture:removeAll'),
  openFolder: (p) => ipcRenderer.invoke('util:openFolder', p),
  removeCapture: (url) => ipcRenderer.invoke('capture:remove', url),
  chooseSavePath: (opts) => ipcRenderer.invoke('util:chooseSavePath', opts),
  getSnapshot: () => ipcRenderer.invoke('app:getSnapshot'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  diagCheck: () => ipcRenderer.invoke('diag:check'),
  openExternal: (url) => ipcRenderer.invoke('util:openExternal', url),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  openPath: (p) => ipcRenderer.invoke('util:openPath', p),
  onTaskEvent: (cb) => ipcRenderer.on('task:event', (_e, ev) => cb(ev)),
  onCapture: (cb) => ipcRenderer.on('capture:new', (_e, entries) => cb(entries)),
});
