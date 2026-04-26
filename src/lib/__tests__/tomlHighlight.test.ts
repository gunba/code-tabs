import { describe, it, expect } from "vitest";
import { highlightToml } from "../tomlHighlight";

describe("highlightToml", () => {
  it("colors section headers", () => {
    const html = highlightToml("[shell_environment_policy]\ninherit = \"core\"");
    expect(html).toContain('<span class="sh-section">[shell_environment_policy]</span>');
  });

  it("colors keys, strings, numbers, and booleans", () => {
    const html = highlightToml('model = "gpt-5"\nmax_depth = 5\nallow_login_shell = true');
    expect(html).toContain('<span class="sh-key">model</span>');
    expect(html).toContain('<span class="sh-string">&quot;gpt-5&quot;</span>');
    expect(html).toContain('<span class="sh-key">max_depth</span>');
    expect(html).toContain('<span class="sh-number">5</span>');
    expect(html).toContain('<span class="sh-bool">true</span>');
  });

  it("colors comments to end of line", () => {
    const html = highlightToml("# top comment\nmodel = \"gpt-5\" # trailing");
    expect(html).toContain('<span class="sh-comment"># top comment</span>');
    expect(html).toContain('<span class="sh-comment"># trailing</span>');
  });

  it("escapes HTML metacharacters", () => {
    const html = highlightToml('user_agent = "<bot>"');
    expect(html).toContain('&lt;bot&gt;');
    expect(html).not.toContain('<bot>');
  });

  it("handles double-bracket array headers", () => {
    const html = highlightToml("[[mcp_servers.docs]]\ncommand = \"x\"");
    expect(html).toContain('<span class="sh-section">[[mcp_servers.docs]]</span>');
  });
});
