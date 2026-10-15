Feature: Score levels are numbered from 0 on purpose, and the panel says so

  Background:
    Given the Score panel is open with the shared levels

  Scenario: A Score panel with four levels labels them from 0
    Given a Score panel with four levels
    When it renders
    Then the level labels read "Level 0", "Level 1", "Level 2", and "Level 3"
    And the hint "Levels are numbered from 0, as the model reports them." is shown under the levels list

  Scenario: The levels hint is linked to the levels list for assistive technology
    Given a Score panel with four levels
    When it renders
    Then the levels list is described by the hint

  Scenario: Options keep their 1-based numbering
    Given a Choice panel with two options
    When it renders
    Then the option labels read "Option 1 name" and "Option 2 name"
    And no levels hint is shown

  Scenario: Adding a level keeps the 0-based labels
    Given a Score panel with four levels
    When the owner adds a level
    Then the new level is labelled "Level 4"

  Scenario: Live check (manual, run by the coordinator in Chrome)
    Given vp dev is running on port 5199
    When the owner opens the Score example
    Then the levels list shows "Level 0" through "Level 3" with the hint beneath it
    And the readout's score ticks and legend keys still start at 0
