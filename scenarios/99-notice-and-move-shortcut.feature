Feature: The image limit notice is announced once, and the Alt + Arrow move shortcut is named on the page

  Background:
    Given the status line (role="status") announces only what the user caused, and nothing on initial render
    And the image limit notice beside each image control is not a live region
    # The status line already announces a provider change, including the over-limit and text-only messages. A live
    # notice would announce the same message a second time. The notice is also rewritten on every add and remove,
    # so a live notice would repeat the over-limit message each time the person removes an image.

  # --- The image limit notice -----------------------------------------------------------------------------------------

  Scenario: A provider change that pushes images over the limit is announced once
    Given a panel with eight images attached on OpenAI Decisions
    When the provider is changed to SubQ Snap, which takes four images
    Then the status line announces "4 images are over the limits of SubQ Snap: up to 4 images, 64 KB in total. Remove the 4 marked images to run."
    And the notice beside the image control shows the same message, without a live region
    And no other live region on the page holds that message

  Scenario: A provider change to a text-only provider is announced once
    Given a panel with one image attached on SubQ Snap
    When the provider is changed to TypeSafe Jev, which takes no images
    Then the status line announces "TypeSafe Jev is text only; your 1 image is kept and will not be sent"
    And the notice shows "TypeSafe Jev is text only. Your 1 image is kept and will not be sent.", without a live region
    And no other live region on the page holds that message

  Scenario: Removing a marked image updates the notice without announcing it again
    Given a panel whose images are over the limit on SubQ Snap, and whose status line has announced the over-limit message
    When the person removes one of the marked images
    Then the status line announces the removal and how many images remain
    And the notice updates its text without a live region announcing the change

  # --- The Alt + Arrow move shortcut ----------------------------------------------------------------------------------

  Scenario: Each question's move buttons name the shortcut
    Given a "Yes or no" panel with four questions
    Then each question's Move up button has aria-keyshortcuts "Alt+ArrowUp"
    And each question's Move down button has aria-keyshortcuts "Alt+ArrowDown"
    And no other control on the page has aria-keyshortcuts
    # The values follow the WAI-ARIA definition of aria-keyshortcuts: modifiers first, joined to the key name with "+".

  Scenario: The questions list shows a hint that names the shortcut when it has two or more questions
    Given a "Yes or no" panel with four questions
    Then the questions list shows the hint "Press Alt and an arrow key to move the focused question." in the tree's hint style
    And the list's aria-describedby includes the hint's id, so a screen reader reads the hint on entering the list

  Scenario: The questions list shows no hint with one question or none
    Given a "Yes or no" panel with one question, or with no questions
    Then the questions list shows no move hint
    And the list has no aria-describedby pointing at a hint
    And the question's Move up and Move down buttons still carry their aria-keyshortcuts values, when there is one question
    # With one question there is nothing to move past, so the sentence would describe something that cannot happen.

  Scenario: The hint appears and disappears as questions are added and removed
    Given a "Yes or no" panel with one question
    When the person adds a question
    Then the questions list shows the move hint, and its aria-describedby names it
    When the person removes a question, leaving one
    Then the move hint is gone, and the list has no aria-describedby

  Scenario: Each score level's move buttons name the shortcut
    Given a "Score on a scale" panel with four shared levels, and one question that has levels of its own
    Then each level's Move up button has aria-keyshortcuts "Alt+ArrowUp", and each level's Move down button has aria-keyshortcuts "Alt+ArrowDown"
    And the shared levels list and the question's own levels list each show the hint "Press Alt and an arrow key to move the focused level."

  Scenario: A levels list with one level shows no move hint
    Given a "Score on a scale" panel whose shared levels are reduced to one level
    Then the shared levels list shows no move hint, and its aria-describedby names only the numbering hint
    And the level's Move up and Move down buttons still carry their aria-keyshortcuts values

  Scenario: The shortcut still moves the focused question
    Given a "Yes or no" panel with four questions, and focus in the Id field of the first question
    When Alt and ArrowDown are pressed
    Then the first question moves down one place
    And focus stays in its Id field
