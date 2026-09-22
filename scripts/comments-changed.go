// Runs Vale on the lines a change added, not on the files it touched.
//
// The tree still carries Japanese comments from before the switch to English
// (September 2026). Linting whole files would make a one-line fix translate
// the hundred lines around it, so this keeps only the alerts whose line is
// new since <base>:
//
//	go run scripts/comments-changed.go <base>   # git diff <base>, working tree
//
// Exit 1 when an error-level alert survives; warnings and suggestions are
// printed and let through, as Vale itself does.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// The globs .vale.ini lints; git narrows the diff to them.
var globs = []string{"*.rs", "*.ts", "*.tsx", "*.js", "*.css"}

var hunkHeader = regexp.MustCompile(`^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@`)

type alert struct {
	Line     int
	Severity string
	Message  string
	Check    string
	Match    string
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: comments-changed.go <base>")
		os.Exit(2)
	}
	added := addedLines(os.Args[1])
	if len(added) == 0 {
		fmt.Println("comments-changed: no source lines added")
		return
	}
	files := make([]string, 0, len(added))
	for f := range added {
		files = append(files, f)
	}
	sort.Strings(files)

	// --no-exit: Vale's own exit code says "errors exist", but the errors on
	// untouched lines are exactly what this script drops
	cmd := exec.Command("vale", append([]string{"--output=JSON", "--no-exit"}, files...)...)
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		fmt.Fprintln(os.Stderr, "vale:", err)
		os.Exit(2)
	}
	report := map[string][]alert{}
	if err := json.Unmarshal(out, &report); err != nil {
		fmt.Fprintln(os.Stderr, "vale output:", err)
		os.Exit(2)
	}

	failed := false
	for _, file := range files {
		alerts := report[file]
		sort.SliceStable(alerts, func(i, j int) bool { return alerts[i].Line < alerts[j].Line })
		lines := fileLines(file)
		for _, a := range alerts {
			line := a.Line
			// Vale reports the second and later lines of a Rust `///` block one
			// line late (vale 3.17). The match text says which line it really is
			if !lineHas(lines, line, a.Match) && lineHas(lines, line-1, a.Match) {
				line--
			}
			if !added[file][line] {
				continue
			}
			fmt.Printf("%s:%d: %s: %s (%s)\n", file, line, a.Severity, a.Message, a.Check)
			if a.Severity == "error" {
				failed = true
			}
		}
	}
	if failed {
		os.Exit(1)
	}
}

// addedLines maps each changed file to the set of line numbers the working
// tree added or rewrote relative to base.
func addedLines(base string) map[string]map[int]bool {
	args := append([]string{"diff", "-U0", "--no-color", "--diff-filter=AMR", base, "--"}, globs...)
	cmd := exec.Command("git", args...)
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		fmt.Fprintln(os.Stderr, "git diff:", err)
		os.Exit(2)
	}
	added := map[string]map[int]bool{}
	var file string
	for _, raw := range bytes.Split(out, []byte("\n")) {
		l := string(raw)
		switch {
		case strings.HasPrefix(l, "+++ b/"):
			file = strings.TrimPrefix(l, "+++ b/")
			added[file] = map[int]bool{}
		case strings.HasPrefix(l, "@@"):
			m := hunkHeader.FindStringSubmatch(l)
			if m == nil || file == "" {
				continue
			}
			start, _ := strconv.Atoi(m[1])
			count := 1
			if m[2] != "" {
				count, _ = strconv.Atoi(m[2])
			}
			for i := 0; i < count; i++ {
				added[file][start+i] = true
			}
		}
	}
	for f, set := range added {
		if len(set) == 0 {
			delete(added, f)
		}
	}
	return added
}

func fileLines(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return strings.Split(string(data), "\n")
}

func lineHas(lines []string, line int, match string) bool {
	if match == "" || line < 1 || line > len(lines) {
		return false
	}
	return strings.Contains(lines[line-1], match)
}
