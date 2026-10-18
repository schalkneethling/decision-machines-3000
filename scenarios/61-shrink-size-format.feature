Feature: A shrink's request budget reads as a size a person can read, and never contradicts the picture's size

  Background:
    Given a request is capped at 64 KiB, and the image control runs the shrink transform
    And the shrink's budget is the smaller of the per-image cap and the room left in the request
    # A catalog limit is a round size and is written exactly ("64 KB", "2 MB"). The room left in a request can be
    # any number of bytes, so it is written like a measured size, rounded, or in bytes when rounding would make it
    # read the same as the picture's size or larger.

  Scenario: Room that is not a whole number of kibibytes is rounded, with no decimal tail
    Given an attached image of 31,237 bytes, which leaves 34,299 bytes of room
    When the shrink refuses a 40,000-byte picture
    Then the message says "it is 39 KB, over the 33 KB it must fit in"
    And the message does not contain "33.4951171875"

  Scenario: A picture that rounds to the room's size is shown beside it in bytes
    Given an attached image of 30,636 bytes, which leaves 34,900 bytes of room
    When the shrink refuses a 35,000-byte picture
    Then the message says "it is 35,000 bytes, over the 34,900 bytes it must fit in"
    # Rounded, the picture would read 34 KB, which is less than the 34.08 KB of room it failed to fit.

  Scenario: A picture whose rounded size is clearly larger than the room keeps the rounded form
    Given 34,900 bytes of room
    When the shrink refuses a 35,328-byte picture
    Then the message says "it is 35 KB, over the 34 KB it must fit in"

  Scenario: Room that is a whole number of kibibytes by chance is still rounded
    Given a larger request cap, and 1,100 KiB of room left
    When the shrink refuses a 3 MB picture
    Then the message says "it is 3.0 MB, over the 1.1 MB it must fit in"
    # Written exactly, 1,100 KiB would read "1.07421875 MB".

  Scenario: A budget that is a catalog limit still reads as it did
    Given an empty request, so the budget is the 64 KiB cap
    When the shrink refuses a 5 MB picture
    Then the message says "it is 5.0 MB, over the 64 KB it must fit in"

  Scenario: The size helpers cover both kinds of budget and a rounding boundary
    When the tests of src/providers/byte-size.ts run
    Then they cover a budget that is not a whole number of kibibytes
    And they cover one picture size on each side of a rounding boundary

  Scenario: The request-total refusal in admit never reads the total as equal to the limit
    Given the per-request limit is a catalog limit, such as 64 KB or 2 MB
    When the images would add up to a few bytes over it
    Then the message gives the total in exact bytes and the limit as "64 KB" or "2 MB"
