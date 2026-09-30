export interface Config {
  telegram: {
    botUsername: string
    whitelistedUsers: string[]
  }
  news: {
    defaultFilter: string
  }
}
