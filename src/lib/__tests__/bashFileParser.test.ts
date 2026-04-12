import { describe, it, expect } from "vitest";
import { parseBashFileOps } from "../bashFileParser";

const CWD = "C:/Users/test/project";

describe("parseBashFileOps", () => {
  describe("read commands", () => {
    it("cat with file path", () => {
      expect(parseBashFileOps("cat src/file.ts", CWD)).toEqual([
        { path: `${CWD}/src/file.ts`, kind: "read" },
      ]);
    });

    it("head with file path", () => {
      expect(parseBashFileOps("head -n 10 src/file.ts", CWD)).toEqual([
        { path: `${CWD}/src/file.ts`, kind: "read" },
      ]);
    });

    it("tail with file path", () => {
      expect(parseBashFileOps("tail -f src/log.txt", CWD)).toEqual([
        { path: `${CWD}/src/log.txt`, kind: "read" },
      ]);
    });

    it("source command", () => {
      expect(parseBashFileOps("source ./scripts/setup.sh", CWD)).toEqual([
        { path: `${CWD}/./scripts/setup.sh`, kind: "read" },
      ]);
    });

    it("diff with two files", () => {
      expect(parseBashFileOps("diff src/a.ts src/b.ts", CWD)).toEqual([
        { path: `${CWD}/src/a.ts`, kind: "read" },
        { path: `${CWD}/src/b.ts`, kind: "read" },
      ]);
    });
  });

  describe("delete commands", () => {
    it("rm with file path", () => {
      expect(parseBashFileOps("rm src/file.ts", CWD)).toEqual([
        { path: `${CWD}/src/file.ts`, kind: "deleted" },
      ]);
    });

    it("rm -rf with directory path", () => {
      expect(parseBashFileOps("rm -rf ./dist/old", CWD)).toEqual([
        { path: `${CWD}/./dist/old`, kind: "deleted" },
      ]);
    });
  });

  describe("create commands", () => {
    it("touch creates file", () => {
      expect(parseBashFileOps("touch src/new.ts", CWD)).toEqual([
        { path: `${CWD}/src/new.ts`, kind: "created" },
      ]);
    });

    it("mkdir -p creates directory", () => {
      expect(parseBashFileOps("mkdir -p src/lib/new", CWD)).toEqual([
        { path: `${CWD}/src/lib/new`, kind: "created" },
      ]);
    });
  });

  describe("copy commands", () => {
    it("cp source → destination", () => {
      expect(parseBashFileOps("cp src/a.ts dst/b.ts", CWD)).toEqual([
        { path: `${CWD}/src/a.ts`, kind: "read" },
        { path: `${CWD}/dst/b.ts`, kind: "created" },
      ]);
    });
  });

  describe("move commands", () => {
    it("mv source → destination", () => {
      expect(parseBashFileOps("mv old.ts new.ts", CWD)).toEqual([
        { path: `${CWD}/old.ts`, kind: "deleted" },
        { path: `${CWD}/new.ts`, kind: "created" },
      ]);
    });
  });

  describe("modify commands", () => {
    it("chmod modifies file", () => {
      expect(parseBashFileOps("chmod +x script.sh", CWD)).toEqual([
        { path: `${CWD}/script.sh`, kind: "modified" },
      ]);
    });

    it("tee writes to file", () => {
      expect(parseBashFileOps("echo hello | tee out.log", CWD)).toEqual([
        { path: `${CWD}/out.log`, kind: "modified" },
      ]);
    });
  });

  describe("redirections", () => {
    it("output redirect > file", () => {
      expect(parseBashFileOps("echo hello > out.txt", CWD)).toEqual([
        { path: `${CWD}/out.txt`, kind: "modified" },
      ]);
    });

    it("append redirect >> file", () => {
      expect(parseBashFileOps("echo hello >> out.txt", CWD)).toEqual([
        { path: `${CWD}/out.txt`, kind: "modified" },
      ]);
    });

    it("input redirect < file", () => {
      expect(parseBashFileOps("sort < data.csv", CWD)).toEqual([
        { path: `${CWD}/data.csv`, kind: "read" },
      ]);
    });

    it("stderr redirect 2> file", () => {
      expect(parseBashFileOps("cmd 2> errors.log", CWD)).toEqual([
        { path: `${CWD}/errors.log`, kind: "modified" },
      ]);
    });

    it("combined cat → redirect", () => {
      const ops = parseBashFileOps("cat src/file.ts > out.log", CWD);
      expect(ops).toContainEqual({ path: `${CWD}/out.log`, kind: "modified" });
      expect(ops).toContainEqual({ path: `${CWD}/src/file.ts`, kind: "read" });
    });
  });

  describe("complex / bail-out cases", () => {
    it("returns empty for loops", () => {
      expect(parseBashFileOps("for f in *.ts; do cat $f; done", CWD)).toEqual([]);
    });

    it("returns empty for subshells with $", () => {
      expect(parseBashFileOps("echo $(cat file.ts)", CWD)).toEqual([]);
    });

    it("returns empty for backtick subshells", () => {
      expect(parseBashFileOps("echo `cat file.ts`", CWD)).toEqual([]);
    });

    it("returns empty for if/then/fi", () => {
      expect(parseBashFileOps("if [ -f file.ts ]; then cat file.ts; fi", CWD)).toEqual([]);
    });

    it("skips command parsing for >3 pipe segments (keeps redirects)", () => {
      const ops = parseBashFileOps("a | b | c | d > out.log", CWD);
      // Redirects are extracted before command parsing
      expect(ops).toContainEqual({ path: `${CWD}/out.log`, kind: "modified" });
      // But command args are not parsed (>3 segments)
      expect(ops.length).toBe(1);
    });

    it("returns empty for empty command", () => {
      expect(parseBashFileOps("", CWD)).toEqual([]);
    });
  });

  describe("path filtering", () => {
    it("skips glob patterns in arguments", () => {
      expect(parseBashFileOps("cat src/*.ts", CWD)).toEqual([]);
    });

    it("skips flags", () => {
      expect(parseBashFileOps("cat -n", CWD)).toEqual([]);
    });

    it("skips URLs", () => {
      expect(parseBashFileOps("cat https://example.com/file.ts", CWD)).toEqual([]);
    });

    it("skips tokens without slash or dot", () => {
      // "cat" with an argument that is just a word with no path-like qualities
      expect(parseBashFileOps("cat README", CWD)).toEqual([]);
    });

    it("rejects quote-contaminated redirect targets", () => {
      // The redirect regex may capture a target with residual quote chars
      // from quoted strings — isPlausiblePath should reject these
      const ops = parseBashFileOps('echo "wrote > src/config.ts" > output.txt', CWD);
      expect(ops).toEqual([{ path: `${CWD}/output.txt`, kind: "modified" }]);
    });

    it("ignores > inside single-quoted strings (Rust type signatures)", () => {
      // Regression: rg/grep patterns containing `>` (e.g. `-> &str>`) were being
      // parsed as redirect operators, polluting the activity tree with folders
      // like `&str>` and `&str>,/n`.
      expect(
        parseBashFileOps("rg 'fn foo() -> &str>' src/lib", CWD),
      ).toEqual([]);
      expect(
        parseBashFileOps("rg 'HashMap<&str, &str>\\n' src/lib", CWD),
      ).toEqual([]);
    });

    it("ignores > inside double-quoted strings", () => {
      expect(
        parseBashFileOps('rg "fn foo() -> Vec<&str>" src/lib', CWD),
      ).toEqual([]);
    });

    it("still extracts a real redirect after a quoted string containing >", () => {
      const ops = parseBashFileOps(
        "rg 'fn foo() -> &str>' src/lib > out.log",
        CWD,
      );
      expect(ops).toEqual([{ path: `${CWD}/out.log`, kind: "modified" }]);
    });
  });

  describe("absolute paths", () => {
    it("preserves absolute Unix paths", () => {
      expect(parseBashFileOps("cat /etc/hosts", CWD)).toEqual([
        { path: "/etc/hosts", kind: "read" },
      ]);
    });

    it("preserves absolute Windows paths", () => {
      expect(parseBashFileOps("cat C:/Users/test/file.ts", CWD)).toEqual([
        { path: "C:/Users/test/file.ts", kind: "read" },
      ]);
    });
  });

  describe("prefix stripping", () => {
    it("handles sudo prefix", () => {
      expect(parseBashFileOps("sudo cat ./src/file.ts", CWD)).toEqual([
        { path: `${CWD}/./src/file.ts`, kind: "read" },
      ]);
    });

    it("handles env prefix", () => {
      expect(parseBashFileOps("env cat ./src/file.ts", CWD)).toEqual([
        { path: `${CWD}/./src/file.ts`, kind: "read" },
      ]);
    });

    it("handles VAR=val prefix", () => {
      expect(parseBashFileOps("VAR=1 cat ./src/file.ts", CWD)).toEqual([
        { path: `${CWD}/./src/file.ts`, kind: "read" },
      ]);
    });
  });

  describe("max ops limit", () => {
    it("caps at 5 ops", () => {
      const ops = parseBashFileOps(
        "cat a.ts b.ts c.ts d.ts e.ts f.ts g.ts",
        CWD,
      );
      expect(ops.length).toBeLessThanOrEqual(5);
    });
  });

  describe("unrecognized commands", () => {
    it("returns empty for sed (not in any command set)", () => {
      expect(parseBashFileOps("sed 's/foo/bar/' file.ts", CWD)).toEqual([]);
    });

    it("returns empty for npm commands", () => {
      expect(parseBashFileOps("npm install", CWD)).toEqual([]);
    });

    it("returns empty for git commands", () => {
      expect(parseBashFileOps("git status", CWD)).toEqual([]);
    });
  });

  describe("semicolons / simple pipes", () => {
    it("handles semicolon-separated commands", () => {
      const ops = parseBashFileOps("cat src/a.ts; rm src/b.ts", CWD);
      expect(ops).toContainEqual({ path: `${CWD}/src/a.ts`, kind: "read" });
      expect(ops).toContainEqual({ path: `${CWD}/src/b.ts`, kind: "deleted" });
    });

    it("handles 2-segment pipe", () => {
      const ops = parseBashFileOps("cat src/file.ts | grep foo", CWD);
      expect(ops).toContainEqual({ path: `${CWD}/src/file.ts`, kind: "read" });
    });
  });
});
