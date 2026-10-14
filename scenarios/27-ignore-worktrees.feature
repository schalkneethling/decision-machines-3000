Feature: Agent worktrees under .claude/worktrees are not part of this repository

  Scenario: vp check ignores files in an agent worktree
    Given a mis-formatted file inside .claude/worktrees/probe/
    When vp check runs
    Then the file is not reported
    And the file counts match a run without the worktree

  Scenario: vp check --fix leaves an agent worktree untouched
    Given a mis-formatted file inside .claude/worktrees/probe/
    When vp check --fix runs
    Then the file content is unchanged

  Scenario: git status ignores agent worktrees
    Given a worktree folder under .claude/worktrees/
    When git status runs
    Then .claude/worktrees/ is not listed as untracked

  Scenario: The rest of .claude stays visible to git
    Given a file at .claude/settings.json
    When git status runs
    Then the file is listed as untracked
