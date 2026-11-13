import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  findLocalResume,
  isResumeAvailable,
  safeResumeFilename,
} from '../../services/resumeService';

describe('resumeService', () => {
  let directory: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
    delete process.env.PORTFOLIO_DATA_SOURCE;
    delete process.env.MCP_PORTFOLIO_URL;
    delete process.env.MCP_PORTFOLIO_COMMAND;
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  const write = (name: string) => fs.writeFileSync(path.join(directory, name), '%PDF-1.4');

  describe('findLocalResume', () => {
    it("returns the profile's file when it exists", () => {
      write('ray.pdf');
      write('resume.pdf');
      expect(findLocalResume('ray.pdf', directory)).toBe(path.join(directory, 'ray.pdf'));
    });

    it("falls back to resume.pdf when the profile's file is missing", () => {
      write('resume.pdf');
      expect(findLocalResume('ray.pdf', directory)).toBe(path.join(directory, 'resume.pdf'));
    });

    it('uses resume.pdf when the profile names no file', () => {
      write('resume.pdf');
      expect(findLocalResume(null, directory)).toBe(path.join(directory, 'resume.pdf'));
    });

    it('returns null when neither file exists', () => {
      expect(findLocalResume('ray.pdf', directory)).toBeNull();
    });

    it('never resolves a profile filename outside the directory', () => {
      // A real file one level up, which a traversal would otherwise reach.
      const outside = path.join(path.dirname(directory), `${path.basename(directory)}-secret.pdf`);
      fs.writeFileSync(outside, 'secret');
      try {
        const traversal = `../${path.basename(outside)}`;
        expect(findLocalResume(traversal, directory)).toBeNull();
        expect(findLocalResume(outside, directory)).toBeNull();

        write('resume.pdf');
        expect(findLocalResume(traversal, directory)).toBe(path.join(directory, 'resume.pdf'));
      } finally {
        fs.rmSync(outside, { force: true });
      }
    });
  });

  describe('safeResumeFilename', () => {
    it.each(['ray.manguino.pdf', 'Resume 2026.pdf'])('keeps the plain name %s', (name) => {
      expect(safeResumeFilename(name)).toBe(name);
    });

    it.each([
      null,
      undefined,
      '',
      '.',
      '..',
      '../secret.pdf',
      'sub/ray.pdf',
      '/etc/passwd',
      'C:\\secret.pdf',
      '..\\secret.pdf',
      'ray".pdf',
      'ray\r\n.pdf',
    ])('replaces %j with resume.pdf', (name) => {
      expect(safeResumeFilename(name)).toBe('resume.pdf');
    });
  });

  describe('isResumeAvailable', () => {
    it('is false with the db source and no file on disk', () => {
      expect(isResumeAvailable('ray.pdf', directory)).toBe(false);
    });

    it('is true when a local file exists', () => {
      write('resume.pdf');
      expect(isResumeAvailable('ray.pdf', directory)).toBe(true);
    });

    it('is true with the MCP source configured, without checking the disk', () => {
      process.env.PORTFOLIO_DATA_SOURCE = 'mcp';
      process.env.MCP_PORTFOLIO_URL = 'https://mcp.example.com';
      expect(isResumeAvailable('ray.pdf', directory)).toBe(true);
    });

    it('ignores the MCP source when no connection is configured', () => {
      process.env.PORTFOLIO_DATA_SOURCE = 'mcp';
      expect(isResumeAvailable('ray.pdf', directory)).toBe(false);
    });
  });
});
