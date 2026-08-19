import type { OpenChatAPI } from '../preload/index'

declare global {
  interface Window {
    openchat: OpenChatAPI
  }
}