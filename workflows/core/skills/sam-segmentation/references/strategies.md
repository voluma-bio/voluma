# Strategies for SAM requests

How to plan the requests of a segmentation. The workflow's anatomy reference says how they play out for its
structures.

## Grouping structures into requests

- **Group a request by what you want found together.** Structures in one request are tracked together and never
  share a voxel; a structure left out is tracked onto by its neighbour. So every structure a target could track
  into goes in the target's request, each boxed on a slice where it is separate from its neighbours (up to 16 per
  request). One request per structure costs several times as much and gives overlapping masks.
- **Keep structures of very different size in separate requests.** A small structure in a request of big ones
  costs the mid-size one beside it its track. Find the small ones on the scan grid first (`unlabelled.py`), give
  each a slice and a box (`map_points.py --pieces`), and send them together, one temporary label per 3D piece. A
  piece the stack's edge cuts needs a wider orientation margin first.
