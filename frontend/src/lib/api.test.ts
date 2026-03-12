/**
 * Tests for API client functions
 */

import { ApiClient } from './api';

describe('ApiClient', () => {
  const baseURL = 'http://localhost:8000/api';
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient(baseURL);
  });

  describe('constructor', () => {
    it('should create client with base URL and strip trailing slashes', () => {
      expect(client.baseUrl).toBe('http://localhost:8000/api');
      
      const clientWithSlash = new ApiClient('http://localhost:8000/api/');
      expect(clientWithSlash.baseUrl).toBe('http://localhost:8000/api');
      
      const clientWithMultipleSlashes = new ApiClient('http://localhost:8000/api///');
      expect(clientWithMultipleSlashes.baseUrl).toBe('http://localhost:8000/api');
    });
  });

  describe('token and fingerprint', () => {
    it('should set token and fingerprint', () => {
      client.token = 'test-token-123';
      client.fingerprint = 'test-fp';
      expect(client.token).toBe('test-token-123');
      expect(client.fingerprint).toBe('test-fp');
    });

    it('should clear token when set to null', () => {
      client.token = 'test-token';
      client.token = null;
      expect(client.token).toBeNull();
    });
  });

  describe('headers method', () => {
    it('should return content-type for JSON requests', () => {
      const headers = (client as any).headers(false);
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should omit content-type for binary requests', () => {
      const headers = (client as any).headers(true);
      expect(headers['Content-Type']).toBeUndefined();
    });

    it('should include authorization header when token is set', () => {
      client.token = 'test-token';
      const headers = (client as any).headers(false);
      expect(headers['Authorization']).toBe('Bearer test-token');
    });

    it('should omit authorization header when no token', () => {
      const headers = (client as any).headers(false);
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  describe('url method', () => {
    it('should construct full URL from path', () => {
      const url = (client as any).url('/api/users');
      expect(url).toBe('http://localhost:8000/api/api/users');
    });
  });

  describe('public API methods exist', () => {
    it('should have setup method', () => {
      expect(typeof client.setup).toBe('function');
    });

    it('should have login method', () => {
      expect(typeof client.login).toBe('function');
    });

    it('should have login2fa method', () => {
      expect(typeof client.login2fa).toBe('function');
    });

    it('should have listEntries method', () => {
      expect(typeof client.listEntries).toBe('function');
    });

    it('should have getEntry method', () => {
      expect(typeof client.getEntry).toBe('function');
    });

    it('should have putEntry method', () => {
      expect(typeof client.putEntry).toBe('function');
    });

    it('should have deleteEntry method', () => {
      expect(typeof client.deleteEntry).toBe('function');
    });

    it('should have moveEntry method', () => {
      expect(typeof client.moveEntry).toBe('function');
    });

    it('should have exportAll method', () => {
      expect(typeof client.exportAll).toBe('function');
    });

    it('should have importArchive method', () => {
      expect(typeof client.importArchive).toBe('function');
    });

    it('should have getGitStatus method', () => {
      expect(typeof client.getGitStatus).toBe('function');
    });

    it('should have configureGit method', () => {
      expect(typeof client.configureGit).toBe('function');
    });

    it('should have gitPush method', () => {
      expect(typeof client.gitPush).toBe('function');
    });

    it('should have gitPull method', () => {
      expect(typeof client.gitPull).toBe('function');
    });
  });
});
