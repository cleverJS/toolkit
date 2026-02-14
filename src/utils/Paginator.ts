export interface IPaginatorOptions {
  page?: number
  perPage?: number
  skipTotal?: boolean
}

export class Paginator {
  private readonly page: number
  private readonly perPage: number
  private readonly skipTotal: boolean
  private total: number = 0

  public constructor(options: IPaginatorOptions = {}) {
    this.page = Math.max(1, options.page ?? 1)
    this.perPage = Math.max(1, options.perPage ?? 10)
    this.skipTotal = options.skipTotal ?? false
  }

  public getPage(): number {
    return this.page
  }

  public getPerPage(): number {
    return this.perPage
  }

  public getLimit(): number {
    return this.perPage
  }

  public getOffset(): number {
    return this.perPage * (this.page - 1)
  }

  public getTotal(): number {
    return this.total
  }

  public setTotal(total: number): void {
    this.total = Math.max(0, total)
  }

  public isSkipTotal(): boolean {
    return this.skipTotal
  }

  public getPageCount(): number {
    return this.perPage ? Math.ceil(this.total / this.perPage) : 0
  }
}
