export interface Config {
  telegram: {
    botUsername: string
    whitelistedUsers: string[]
    allowedGroupIds?: string[]
  }
  news: {
    defaultFilter: string
    readonly relevanceThreshold: number
  }
}
