/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: softtabstop=2:shiftwidth=2:expandtab
 * */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

// Original author: bcampen@mozilla.com

#ifndef mediapipelinefilter_h__
#define mediapipelinefilter_h__

#include <cstddef>
#include <stdint.h>

#include <set>

namespace webrtc {
class RTPHeader;
}

namespace mozilla {

// A class that handles the work of filtering RTP packets that arrive at a
// MediaPipeline. This is primarily important for the use of BUNDLE (ie;
// multiple m-lines share the same RTP stream). There are three ways that this
// can work;
//
// 1) In our SDP, we include a media-level extmap parameter with a unique
//    integer of our choosing, with the hope that the other side will include
//    this value in a header in the first few RTP packets it sends us. This
//    allows us to perform correlation in cases where the other side has not
//    informed us of the ssrcs it will be sending (either because it did not
//    include them in its SDP, or their SDP has not arrived yet)
//    and also gives us the opportunity to learn SSRCs from packets so adorned.
//
// 2) If the remote endpoint includes SSRC media-level attributes in its SDP,
//    we can simply use this information to populate the filter. The only
//    shortcoming here is when RTP packets arrive before the answer does. See
//    above.
//
// 3) As a fallback, we can try to use payload type IDs to perform correlation,
//    but only when the type id is unique to this media section.
//    This too allows us to learn about SSRCs (mostly useful for filtering
//    any RTCP packets that follow).
class MediaPipelineFilter {
 public:
  MediaPipelineFilter();

  // Checks whether this packet passes the filter, possibly updating the filter
  // in the process (if the correlator or payload types are used, they can teach
  // the filter about ssrcs)
  bool Filter(const webrtc::RTPHeader& header, uint32_t correlator = 0);

  // RTCP doesn't have things like the RTP correlator, and uses its own
  // payload types too.
  // RTCP receiver reports use _our_ ssrcs
  bool FilterRTCPReceiverReport(uint32_t ssrc);
  // The rest of RTCP uses their ssrcs
  bool FilterRTCP(uint32_t ssrc);

  void AddLocalSSRC(uint32_t ssrc);
  void AddRemoteSSRC(uint32_t ssrc);

  // When a payload type id is unique to our media section, add it here.
  void AddUniquePT(uint8_t payload_type);
  void SetCorrelator(uint32_t correlator);

  void IncorporateRemoteDescription(const MediaPipelineFilter& remote_filter);

 private:
  uint32_t correlator_;
  // The number of filters we manage here is quite small, so I am optimizing
  // for readability.
  std::set<uint32_t> remote_ssrc_set_;
  std::set<uint32_t> local_ssrc_set_;
  std::set<uint8_t> payload_type_set_;
};

} // end namespace mozilla

#endif // mediapipelinefilter_h__

