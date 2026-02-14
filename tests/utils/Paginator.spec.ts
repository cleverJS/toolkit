import { describe, expect, it } from 'vitest'

import { Paginator } from '../../src'

describe('Paginator', () => {
  describe('constructor defaults', () => {
    it('should default to page 1, perPage 10, skipTotal false', () => {
      const paginator = new Paginator()
      expect(paginator.getPage()).toBe(1)
      expect(paginator.getPerPage()).toBe(10)
      expect(paginator.isSkipTotal()).toBe(false)
      expect(paginator.getTotal()).toBe(0)
    })

    it('should accept custom options', () => {
      const paginator = new Paginator({ page: 3, perPage: 25, skipTotal: true })
      expect(paginator.getPage()).toBe(3)
      expect(paginator.getPerPage()).toBe(25)
      expect(paginator.isSkipTotal()).toBe(true)
    })

    it('should clamp page to minimum 1', () => {
      expect(new Paginator({ page: 0 }).getPage()).toBe(1)
      expect(new Paginator({ page: -5 }).getPage()).toBe(1)
    })

    it('should clamp perPage to minimum 1', () => {
      expect(new Paginator({ perPage: 0 }).getPerPage()).toBe(1)
      expect(new Paginator({ perPage: -3 }).getPerPage()).toBe(1)
    })
  })

  describe('getOffset / getLimit', () => {
    it('should return 0 offset for page 1', () => {
      const paginator = new Paginator({ perPage: 10 })
      expect(paginator.getOffset()).toBe(0)
    })

    it('should return correct offset for page 3', () => {
      const paginator = new Paginator({ page: 3, perPage: 10 })
      expect(paginator.getOffset()).toBe(20)
    })

    it('should return perPage as limit', () => {
      const paginator = new Paginator({ perPage: 25 })
      expect(paginator.getLimit()).toBe(25)
    })
  })

  describe('setTotal', () => {
    it('should store total', () => {
      const paginator = new Paginator()
      paginator.setTotal(50)
      expect(paginator.getTotal()).toBe(50)
    })

    it('should clamp negative total to 0', () => {
      const paginator = new Paginator()
      paginator.setTotal(-5)
      expect(paginator.getTotal()).toBe(0)
    })
  })

  describe('getPageCount', () => {
    it('should calculate page count', () => {
      const paginator = new Paginator({ perPage: 10 })
      paginator.setTotal(252)
      expect(paginator.getPageCount()).toBe(26)
    })

    it('should return 0 when total is 0', () => {
      const paginator = new Paginator({ perPage: 10 })
      expect(paginator.getPageCount()).toBe(0)
    })

    it('should round up partial pages', () => {
      const paginator = new Paginator({ perPage: 10 })
      paginator.setTotal(11)
      expect(paginator.getPageCount()).toBe(2)
    })
  })

  describe('skipTotal', () => {
    it('should default to false', () => {
      const paginator = new Paginator()
      expect(paginator.isSkipTotal()).toBe(false)
    })

    it('should accept skipTotal via constructor', () => {
      const paginator = new Paginator({ skipTotal: true })
      expect(paginator.isSkipTotal()).toBe(true)
    })
  })
})
