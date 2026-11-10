Feature: Number the attached images on screen and say when the numbers change

  Background:
    Given the hint tells the user to ask about images by number, and the first image in the list is image 1
    And the list of attached images is an ordered list, with role="list" kept because Safari drops list semantics from a list styled with list-style: none

  Scenario: Three images are listed as Image 1, Image 2, and Image 3
    Given a panel with three images attached
    Then the list is an ordered list
    And the items read "Image 1", "Image 2", and "Image 3"

  Scenario: Removing a middle image says which numbers changed
    Given a panel with three images attached
    When the person removes image 2
    Then the status line says "Image 3 is now image 2. Check questions that mention image numbers."
    And the remaining items read "Image 1" and "Image 2"

  Scenario: Removing an earlier image with several images after it names a range
    Given a panel with four images attached
    When the person removes image 2
    Then the status line says "Images 3 to 4 are now images 2 to 3. Check questions that mention image numbers."

  Scenario: Removing the last image says nothing about renumbering
    Given a panel with three images attached
    When the person removes image 3
    Then the status line does not mention renumbering

  Scenario: Thumbnails are decorative and Remove buttons carry the number and the file name
    Given an attached image named "picture-2.png", the second in the list
    Then its thumbnail has alt=""
    And its Remove button's accessible name is "Remove image 2, picture-2.png"

  Scenario: Replacing the images numbers the new ones from 1
    Given a panel with three images attached
    When the images are replaced by two others
    Then the items read "Image 1" and "Image 2"
