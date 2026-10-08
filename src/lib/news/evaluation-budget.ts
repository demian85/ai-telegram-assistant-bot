export const maxFreshNewsEvaluations = 10

export class NewsEvaluationBudget {
  private remaining: number

  constructor(limit = maxFreshNewsEvaluations) {
    this.remaining = limit
  }

  get exhausted(): boolean {
    return this.remaining <= 0
  }

  take(): boolean {
    if (this.exhausted) return false
    this.remaining--
    return true
  }
}
