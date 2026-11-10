Feature: The warm countdown is silent for screen readers, apart from its start, its end, and failures

  The warm form on the Node dev host shows its countdown in `#warm-status`. That element
  ticks once a second and is plain text with no live role, so a screen reader does not speak
  it when it changes, but a reader can still find it with the virtual cursor. A screen reader
  speaks a live region when its text changes, and the live region here is `#warm-announcer`,
  a visually hidden `role="status"` element. `src/ui/warm.ts` writes to the announcer only
  at three moments: the start of a warm or a restart, the end when the count reaches zero,
  and a failed warm. A tick changes the visible text and leaves the announcer alone.

  Background:
    Given the warm form on the Node dev host with TypeSafe Jev selected

  Scenario: A successful warm is announced once, with its latency and keep-alive
    When Warm is pressed and the warm route answers with a 950 ms latency and a 30 s keep-alive
    Then the live region reads "Connection warmed in 950 ms. Warm for 30 s." once
    And the visible status line reads the same sentence

  Scenario: Each tick changes the visible countdown and not the live region
    Given a warm has succeeded with a 30 s keep-alive
    When five seconds pass
    Then the visible status line reads "Warm for 25 s."
    And the live region has not changed since the warm was announced

  Scenario: The end of the countdown is announced once
    Given a warm has succeeded with a 4 s keep-alive
    When the count reaches zero
    Then the visible status line reads "Connection is cold again."
    And the live region reads "Connection is cold again." once
    And the live region is not changed again

  Scenario: A run restarts the count, and the restart is announced once
    Given a warm countdown is running
    When a run answers over the warm connection with a 60 s keep-alive
    Then the live region reads "Warm for 60 s." once

  Scenario: A failed warm is announced
    When Warm is pressed and the warm route answers 502 with "Could not reach TypeSafe Jev."
    Then the live region reads "Could not warm the connection. Could not reach TypeSafe Jev." once
    And the visible status line shows the same sentence in the alert tone

  Scenario: The visible countdown is readable but not a live region, and the live region is in the page
    When index.html is read
    Then `#warm-status` has no role, no aria-live, and no aria-hidden
    And `#warm-announcer` has role "status" and the visually-hidden class

  Scenario: Selecting another provider clears the countdown without announcing anything
    Given a warm countdown for TypeSafe Jev is running
    When SubQ Snap is selected
    Then the visible status line is empty
    And the live region is empty
    And nothing is announced

  # Manual check, run with a screen reader (VoiceOver or NVDA) on the Node dev host.
  # The unit tests prove what is written to the live region. They cannot prove what the
  # screen reader speaks, so check it by ear:
  #  1. Run `vp dev --port 5199 --strictPort` and open http://localhost:5199/.
  #  2. With TypeSafe Jev selected, press Warm and wait for the start sentence.
  #  3. Listen for 30 s. The screen reader should say nothing while the countdown ticks.
  #  4. Let the count reach zero. The screen reader should say "Connection is cold again." once.
  #  5. Press Warm, then Run on a panel within the keep-alive. Check that the restart is spoken once.
