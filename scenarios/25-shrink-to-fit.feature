Feature: Oversized images are shrunk in the browser as soon as they are added

  Background:
    Given the image control from issue #16 (src/ui/attachments.ts) runs every added file through a transform before the size checks
    And every limit comes from the selected provider's capabilities.images as GET /api/providers serves it, never from a constant in the client:
      | provider | maxCount | maxBytesPerImage | maxBytesPerRequest |
      | subq     | 4        | 64 KiB           | 64 KiB             |
      | openai   | 8        | 64 KiB           | 64 KiB             |
    # The issue body asked for an opt-in "Shrink to fit" button, 2 MiB caps, 2048 px as the first step, and no change of
    # format. The owner's comment of 2026-10-16 replaced all four: shrinking is automatic, the format may change, the caps
    # are 64 KiB, and the steps start lower. The scenarios below follow the comment. The body's criteria are rewritten as
    # noted at the end of each scenario that replaces one.
    And shrinking happens in the browser and nothing is uploaded until Run
    And the panel's status line (role="status") announces what the user caused, and nothing on initial render

  # --- The size and quality search (pure; tested with a fake encoder) ------------------------------------------------

  Scenario: The search walks long-edge steps from large to small and quality from high to low, and stops at the first fit
    Given a 4000 by 3000 picture and a target of 64 KiB
    When the search runs with the steps 1024, 768, and 512 px and the qualities 0.8, 0.6, and 0.4
    Then it asks the encoder for 1024 px at 0.8, then 0.6, then 0.4, then 768 px at 0.8, and so on
    And it returns the first result at or under the target, with its pixel size and the step it used
    And it never asks for an edge larger than the picture itself, so a picture is not enlarged

  Scenario: A picture smaller than a step is tried at its own size, once
    Given a 600 by 400 picture
    Then the steps become 600 px, then 512 px, with no repeated edge

  Scenario: The search gives up with a clear result when even the smallest step is over
    Given an encoder that always returns 80 KiB
    When the search runs
    Then it returns "too big" with the smallest size it tried and the smallest byte count it saw
    And it asked the encoder once for each step and quality, and not more
    # Rewrites "an image still over the limit at the smallest step is left unchanged with a message".

  Scenario: An encoder that ignores the requested type is not asked for more qualities
    Given an encoder asked for image/webp that answers with image/png (Safari does this)
    When the result is over the target
    Then the other qualities at that edge are skipped, because PNG has no quality setting, and the next edge is tried

  # --- Transparency and the output format ---------------------------------------------------------------------------

  Scenario: An opaque picture becomes a JPEG
    Given a PNG, JPEG, or WebP without transparent pixels is over the limit
    When it is shrunk
    Then the result is an image/jpeg whose first bytes are the JPEG signature
    And the file's declared type is image/jpeg and its name ends in ".jpg"

  Scenario: A picture with transparency becomes a WebP
    Given a PNG with transparent pixels is over the limit
    When it is shrunk
    Then the result is an image/webp whose first bytes are RIFF and WEBP, not a JPEG (JPEG would turn the transparent areas black)
    And the file's name ends in ".webp"
    # Rewrites "a PNG over the limit stays a PNG with the PNG signature".

  Scenario: Transparency is read from the alpha channel
    Given a decoded picture
    When it is drawn at no more than 512 px on its long edge and read back with getImageData
    Then it has transparency when any pixel has an alpha below 255
    And a JPEG source is not scanned, because JPEG has no alpha channel

  Scenario: A browser that cannot encode WebP still gets a valid file
    Given a transparent PNG and a browser whose convertToBlob answers image/png for image/webp
    When the picture is shrunk
    Then the file is declared as the type the encoder really produced, so the declared type matches the bytes
    And if it is still over the target at every step, the refusal names the picture and the target

  # --- Automatic shrinking in the control ---------------------------------------------------------------------------

  Scenario: An oversized photo is shrunk when it is added
    Given SubQ Snap is selected and the browser can decode and encode images
    When a 5.8 MB JPEG is chosen, dropped, or pasted
    Then it is listed as a JPEG of 64 KiB or less, with no button pressed
    And the item shows the size before and after in text ("Shrunk from 5.8 MB to 52 KB") and the new pixel dimensions ("1024 × 768")
    And the status says "Image 1 added: photo.jpg, 52 KB. Shrunk from 5.8 MB to 52 KB (1024 × 768)."
    # Rewrites "a 5.8 MB JPEG is marked over the limit with a Shrink to fit button" and "pressing it makes it 2 MiB or less".

  Scenario: An image already within the limits is not touched
    Given SubQ Snap is selected
    When a 12 KiB PNG is chosen
    Then the transform returns the same File, the item shows no "Shrunk" text, and the status is the plain "Image 1 added" sentence

  Scenario: There is no Shrink button
    Then no attachment has a button other than Remove

  Scenario: The shrink target takes the room left in the request into account
    Given OpenAI Decisions is selected, a 40 KiB image is attached, and the per-image and per-request caps are both 64 KiB
    When a 3 MB JPEG is added
    Then the transform is asked for at most 24 KiB (the smaller of the per-image cap and what is left of the request)
    And the attached total stays at or under 64 KiB
    And when the request is already full, the transform leaves the file alone and the control refuses it with the per-request total

  Scenario: Several large photos fit the request in total
    Given OpenAI Decisions is selected
    When three 4 MB JPEGs are chosen together
    Then each is shrunk to the room left, in order, the total never exceeds 64 KiB, and an image that cannot fit is refused with its own sentence while the others still go on

  Scenario: A picture that cannot be made small enough is refused with a clear message
    Given a picture that is over the target even at 512 px and the lowest quality
    When it is added
    Then it is not listed and the status says "huge.png was not added: it is 6.1 MB, over the 64 KB it must fit in. Even at 512 px on its long edge and the lowest quality it is still 71 KB."

  Scenario: The format check runs again on the shrunk bytes
    Given the shrinker returns a File
    Then the pipeline detects its type again, checks the size again, and reads its pixel size from the new header
    And the File appended to the form declares the type its new bytes show

  Scenario: The shrunk file never leaves the browser before Run
    Then no network request is made when an image is shrunk, and the privacy note under the control is unchanged

  # --- Feature detection and the fallback ---------------------------------------------------------------------------

  Scenario: A browser without OffscreenCanvas or createImageBitmap keeps the over-limit message
    Given a browser where either OffscreenCanvas or createImageBitmap is missing
    When a 5.8 MB JPEG is added
    Then it is refused, and the status says "photo.jpg was not added: it is 5.8 MB, over the 64 KB it must fit in, and this browser cannot shrink images."
    # "The 64 KB it must fit in" is the budget: the smaller of the per-image cap and the room left in the request.
    And an image already within the limits is still added, because it needs no shrinking
    # Rewrites "no Shrink to fit button appears and the over-limit message stands".

  Scenario: A file the browser cannot decode is refused with a reason
    Given a file whose header says PNG but whose data createImageBitmap rejects
    When it is added and it is over the limit
    Then the status says "broken.png was not added: it is 6.1 MB, over the 64 KB it must fit in, and this browser could not decode it to shrink it."

  Scenario: The decoded bitmap is released
    When the search has finished, succeeded or not, or failed part-way
    Then ImageBitmap.close() has been called once

  # --- Accessibility ------------------------------------------------------------------------------------------------

  Scenario: The shrink is announced once, by the panel's status line, and only for what the user did
    Then nothing is announced on initial render
    And adding an oversized image announces one sentence that names the file, both sizes, and the new dimensions
    And the before and after sizes are also in the item's text, not only in the status line

  # --- Manual checks (the coordinator runs these; they need vp dev, which needs 1Password) ------------------------------

  Scenario: Manual, Chrome with a real phone photo
    Given "vp dev --port 5199 --strictPort" is running with SUBQ_API_KEY set, and the page is open in Chrome
    And a photo straight from a phone (a 3 to 8 MB JPEG, preferably with EXIF orientation set so it is shown rotated) is at hand
    When SubQ Snap is selected and the photo is chosen with the file input
    Then the item is listed as a JPEG under 64 KB, shows "Shrunk from N MB to N KB" and the new dimensions, and the picture is the right way up
    And the status line announces the same
    And no request is sent to /api/jev until Run is pressed (Network tab)
    When Run is pressed on the SubQ panel
    Then the run succeeds and the wire view shows one placeholder like "<image 1: image/jpeg, 52 KB>"
    When a PNG screenshot with a transparent background is added
    Then it is listed as image/webp in Chrome, and the transparent areas are not black in the thumbnail
    When the browser console runs "delete window.OffscreenCanvas" before the page loads (or a browser without it is used) and the photo is added
    Then it is refused with the sentence about the browser not being able to shrink images

  Scenario: Manual, Safari with a real phone photo
    Given the same page is open in Safari 16.4 or later
    When the same phone photo is added
    Then it is shrunk to a JPEG under 64 KB and the picture is the right way up
    When a PNG with transparency is added
    Then Safari cannot encode WebP from a canvas, so the file is a PNG made at the largest step that fits
    And either it is listed as image/png, or the refusal names the picture and the target
    And it is never listed as a JPEG with black areas
