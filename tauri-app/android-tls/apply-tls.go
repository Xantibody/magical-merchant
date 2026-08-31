// Command apply-tls wires the Kotlin half of rustls-platform-verifier into the
// Tauri-generated Android Gradle build.
//
// reqwest 0.13 verifies certificates through `rustls-platform-verifier`, and on
// Android that crate reaches the system trust store through a small Kotlin
// component (`org.rustls.platformverifier`). The component ships inside the
// crate as a local Maven repository, so the app module has to be told where to
// find it. Without this the APK builds and then fails every HTTPS request at
// runtime with a certificate error.
//
// src-tauri/gen/android/ is gitignored and recreated by `tauri android init`,
// so this lives here as a repo-tracked patcher and runs as part of
// `just android-init`. Like apply-signing.go, every inserted region is wrapped
// in marker comments and stripped before re-insertion, so re-runs are idempotent.
package main

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

// Paths are relative to tauri-app/, the directory the just recipe runs in.
const (
	gradlePath   = "src-tauri/gen/android/app/build.gradle.kts"
	proguardPath = "src-tauri/gen/android/app/proguard-rules.pro"
)

// injection describes one marker-delimited region to insert into the build
// script. body holds the Kotlin source (already indented); anchor is a literal
// substring of the original file used as the insertion point.
type injection struct {
	id     string
	anchor string
	after  bool // insert after the anchor (true) or before it (false)
	body   string
}

// The component lives inside whichever version of the crate Cargo resolved, so
// both the repository path and the artifact version are read from
// `cargo metadata` rather than hardcoded. `--filter-platform` is required: the
// crate is an Android-only dependency and does not appear in an unfiltered
// graph. The version is pinned from the same JSON rather than left as
// `latest.release`, because the bundled repository ships only a
// `maven-metadata-local.xml` and Gradle cannot resolve a dynamic version
// without the non-local one.
//
// `metadataSources.artifact()` is what lets Gradle consume the bare .aar
// without trusting the POM that sits next to it.
var injections = []injection{
	{
		id:     "repository",
		anchor: "android {",
		after:  false,
		body: `val rustlsPlatformVerifier: Pair<String, String> by lazy {
    val metadata = providers.exec {
        commandLine(
            "cargo", "metadata", "--format-version", "1",
            "--filter-platform", "aarch64-linux-android",
            "--manifest-path", rootProject.file("../../Cargo.toml").absolutePath,
        )
    }.standardOutput.asText.get()

    @Suppress("UNCHECKED_CAST")
    val packages = (groovy.json.JsonSlurper().parseText(metadata) as Map<String, Any>)
        .getValue("packages") as List<Map<String, Any>>
    val pkg = packages.firstOrNull { it["name"] == "rustls-platform-verifier-android" }
        ?: error("rustls-platform-verifier-android not in cargo metadata")

    val maven = File(File(pkg.getValue("manifest_path") as String).parentFile, "maven")
    maven.path to (pkg.getValue("version") as String)
}

repositories {
    maven {
        url = uri(rustlsPlatformVerifier.first)
        metadataSources.artifact()
    }
}
`,
	},
	{
		id:     "dependency",
		anchor: "dependencies {\n",
		after:  true,
		body: `    // The Kotlin side of rustls-platform-verifier, without which reqwest cannot
    // reach Android's trust store. Cargo owns the version.
    implementation("rustls:rustls-platform-verifier:${rustlsPlatformVerifier.second}")
`,
	},
}

// R8 cannot see that JNI reaches into these classes, so a minified release
// build drops them as dead code and TLS fails only in the shipped APK.
const proguardRule = `-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }`

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "apply-tls:", err)
		os.Exit(1)
	}
}

func run() error {
	if err := patchGradle(); err != nil {
		return err
	}
	return patchProguard()
}

func patchGradle() error {
	raw, err := os.ReadFile(gradlePath)
	if err != nil {
		return fmt.Errorf("read %s: %w (run `pnpm tauri android init` first)", gradlePath, err)
	}
	content := string(raw)

	for _, inj := range injections {
		content = removeBlock(content, kotlinComment, inj.id)
	}
	for _, inj := range injections {
		indent := leadingIndent(inj.body)
		block := markerBlock(kotlinComment, inj.id, indent, inj.body)
		content, err = insert(content, inj.anchor, inj.after, block)
		if err != nil {
			return fmt.Errorf("injection %q: %w", inj.id, err)
		}
	}

	if string(raw) == content {
		fmt.Println("apply-tls: gradle unchanged (already up to date)")
		return nil
	}
	if err := os.WriteFile(gradlePath, []byte(content), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", gradlePath, err)
	}
	fmt.Printf("apply-tls: verifier component wired into %s\n", gradlePath)
	return nil
}

func patchProguard() error {
	raw, err := os.ReadFile(proguardPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", proguardPath, err)
	}

	// ProGuard comments start with '#'; a '//' marker would be read as a
	// directive and fail the release build.
	content := removeBlock(string(raw), proguardComment, "proguard")
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	content += markerBlock(proguardComment, "proguard", "", proguardRule+"\n")

	if string(raw) == content {
		fmt.Println("apply-tls: proguard rules unchanged (already up to date)")
		return nil
	}
	if err := os.WriteFile(proguardPath, []byte(content), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", proguardPath, err)
	}
	fmt.Printf("apply-tls: keep rule added to %s\n", proguardPath)
	return nil
}

// The two patched files disagree about what starts a comment.
const (
	kotlinComment   = "//"
	proguardComment = "#"
)

func beginMarker(comment, id string) string {
	return comment + " >>> magical-merchant tls:" + id + " (auto-generated by android-tls/apply-tls.go)"
}

func endMarker(comment, id string) string {
	return comment + " <<< magical-merchant tls:" + id
}

// markerBlock wraps body in begin/end markers indented to match the body.
func markerBlock(comment, id, indent, body string) string {
	var b strings.Builder
	b.WriteString(indent + beginMarker(comment, id) + "\n")
	b.WriteString(body)
	b.WriteString(indent + endMarker(comment, id) + "\n")
	return b.String()
}

// removeBlock deletes a marker region (including its leading indentation and
// trailing newline) for the given id, leaving the surrounding text untouched.
func removeBlock(content, comment, id string) string {
	re := regexp.MustCompile(`(?s)[ \t]*` +
		regexp.QuoteMeta(beginMarker(comment, id)) +
		`.*?` +
		regexp.QuoteMeta(endMarker(comment, id)) +
		`[^\n]*\n`)
	return re.ReplaceAllString(content, "")
}

func insert(content, anchor string, after bool, block string) (string, error) {
	idx := strings.Index(content, anchor)
	if idx < 0 {
		return "", fmt.Errorf("anchor not found: %q", anchor)
	}
	pos := idx
	if after {
		pos = idx + len(anchor)
	}
	return content[:pos] + block + content[pos:], nil
}

// leadingIndent returns the whitespace prefix of the first non-empty line of s.
func leadingIndent(s string) string {
	for _, line := range strings.Split(s, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		return line[:len(line)-len(strings.TrimLeft(line, " \t"))]
	}
	return ""
}
