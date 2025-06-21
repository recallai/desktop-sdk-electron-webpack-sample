import { fileURLToPath } from 'url';

import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();
dotenv.config({ path: process.resourcesPath + "/app/.env" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { app, BrowserWindow, ipcMain, shell, dialog, Notification, Tray, Menu } from 'electron';
import path from 'node:path';
import isDev from 'electron-is-dev';
import RecallAiSdk from '@recallai/desktop-sdk';

let mainWindow;
let detectedMeeting = null;

let state = {
  recording: false,
  permissions_granted: false,
  meetings: [],
};

function sendState() {
  try {
    if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
      mainWindow.webContents.send('state', state);
  } catch (e) {
    console.error("Failed to send message to renderer:", e);
  }
}

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
    },
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  console.log('=== State sent to SDK:', state);
  mainWindow.webContents.on('did-finish-load', () => {
    sendState();
  });
};

function showWindow() {
  if (BrowserWindow.getAllWindows().length <= 1)
    createWindow();
  else
    mainWindow.show();
}

async function createDesktopSdkUpload() {
  const url = 'https://api.recall.ai/api/v1/sdk-upload/';

  const response = await axios.post(url, {}, {
    headers: { 'Authorization': `Token ${process.env.API_KEY}` },
    timeout: 3000,
  });

  return response.data;
}

async function startRecording(windowId) {
  try {
    const { upload_token } = await createDesktopSdkUpload();

    if (!upload_token) {
      throw new Error("No upload token received from the server.");
    }

    RecallAiSdk.startRecording({
      windowId: windowId,
      uploadToken: upload_token
    });
  } catch (error) {
    console.error("Error in startRecording:", error.message);

    dialog.showErrorBox(
      "Recording Error",
      `Failed to start recording:\n${error.message}`
    );

    app.dock.bounce('critical');
  }
}

function getFormattedDate() {
  const now = new Date();

  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const year = String(now.getFullYear()).slice(-2);

  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';

  hours %= 12;
  hours ||= 12;
  const formattedHours = String(hours).padStart(2, '0');

  return `${month}-${day}-${year} ${formattedHours}:${minutes} ${ampm}`;
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  createWindow();

  app.on('activate', () => {
    showWindow();
  });

  app.on('window-all-closed', () => {
    // Do nothing. Electron kills the app when all windows are closed unless we
    // subscribe to this event, and macOS applications usually stay open even
    // with all windows closed.
  });

  RecallAiSdk.init({
    dev: isDev,
    api_url: "https://api.recall.ai",
    config: {}
  });

  ipcMain.on('message-from-renderer', async (event, arg) => {
    console.log('message-from-renderer', arg);
    switch (arg.command) {
      case 'open-recording-folder':
        shell.openPath("/tmp");
        break;
      case 'reupload':
        RecallAiSdk.uploadRecording({ windowId: arg.id });
        break;
      case 'start-recording':
        if (!detectedMeeting) {
          dialog.showMessageBoxSync(null, { message: "There is no meeting in progress." });
          break;
        }
        await startRecording(detectedMeeting.window.id);
        break;
      case 'stop-recording':
        RecallAiSdk.stopRecording({ windowId: detectedMeeting.window.id });
        break;
    }
  });

  RecallAiSdk.addEventListener('meeting-updated', async (evt) => {
    console.log("Meeting updated", evt);
  });

  RecallAiSdk.addEventListener('permissions-granted', async (evt) => {
    console.log("Permissions granted, ready to record");
    state.permissions_granted = true;
    sendState();
  });

  RecallAiSdk.addEventListener('realtime-event', async (evt) => {
    console.log(evt);
  });

  RecallAiSdk.addEventListener('media-capture-status', async (evt) => {
    console.log(evt);
  });

  RecallAiSdk.addEventListener('error', async (evt) => {
    let { type, message } = evt;

    if (type === "upload") {
      for (let meeting of state.meetings) {
        if (meeting.id === evt.window.id)
          meeting.status = "failed";
      }

      sendState();

      dialog.showErrorBox('Upload error', `There was an error uploading the recording. Reason: ${message}`);
    } else {
      dialog.showErrorBox("Error", `An error occurred. Reason: ${type} -- ${message}`);
    }

    new Notification({
      title: 'Error',
      body: 'An error occured.',
    }).show();

    app.dock.bounce('critical');

    console.error("ERROR: ", type, message);
  });

  RecallAiSdk.addEventListener('upload-progress', async (evt) => {
    for (let meeting of state.meetings) {
      if (meeting.id === evt.window.id)
        meeting.uploadPercentage = evt.progress;

      if (evt.progress === 100)
        meeting.status = 'completed';
    }

    sendState();
  });

  RecallAiSdk.addEventListener('recording-ended', async (evt) => {
    state.meetings.push({ title: getFormattedDate(), id: evt.window.id, uploadPercentage: 0, status: "in-progress" });
    sendState();

    RecallAiSdk.uploadRecording({ windowId: evt.window.id });
  });

  RecallAiSdk.addEventListener('meeting-closed', async (evt) => {
    console.log("MEETING CLOSED", evt);
    detectedMeeting = null;
  });

  RecallAiSdk.addEventListener('meeting-detected', async (evt) => {
    detectedMeeting = evt;

    let notif = new Notification({
      title: 'Meeting detected',
      body: 'Click here to record the meeting.',
      actions: [
        {
          type: "button",
          text: "Record"
        },
        {
          type: "button",
          text: "Ignore"
        }
      ]
    });

    notif.on('action', async (_action, index) => {
      if (index === 0)
        await startRecording(evt.window.id);
    });

    notif.on('click', async () => {
      await startRecording(evt.window.id);
    });

    notif.show();
  });

  RecallAiSdk.addEventListener('sdk-state-change', (event) => {
    try {
      switch (event.sdk.state.code) {
        case 'recording':
          app.dock.setBadge('Recording');
          console.log('=== Recording started:', event);
          state.recording = true;
          sendState();
          break;
        case 'idle':
          app.dock.setBadge("");
          console.log('=== Recording idle:', event);
          state.recording = false;
          sendState();
          break;
        case 'paused':
          app.dock.setBadge("Paused");
          console.log('=== Recording paused:', event);
          state.recording = false;
          sendState();
          break;
      }
    } catch (e) {
      console.error(e);
    }
  });
});
