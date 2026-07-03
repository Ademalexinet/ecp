const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  enumContainers:      ()       => ipcRenderer.invoke('enum-containers'),
  installCert:         (cont)   => ipcRenderer.invoke('install-cert', cont),
  installAllCerts:     (list)   => ipcRenderer.invoke('install-all-certs', list),
  chooseArchive:       ()       => ipcRenderer.invoke('choose-archive'),
  extractArchive:      (path)   => ipcRenderer.invoke('extract-archive', path),
  openCryptoProFolder: ()       => ipcRenderer.invoke('open-cryptopro-folder'),
  openCpanel:          ()       => ipcRenderer.invoke('open-cpanel'),
  openCptools:         ()       => ipcRenderer.invoke('open-cptools'),
});
