import type { OpenWisprApi } from '../shared/api'

declare global {
  interface Window {
    openwispr: OpenWisprApi
  }
}
