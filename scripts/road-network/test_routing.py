import unittest
import networkx as nx
from routing import split_snap_groups, shortest_effective

class RoutingTests(unittest.TestCase):
    def test_same_edge_and_reversed_orientation(self):
        g = nx.MultiGraph()
        g.add_edge(0,1,key=0,length=100)
        split_snap_groups(g,[('b',[(0,1,0,0,40,40,60,0)]),('s',[(1,0,0,0,60,40,60,0)])])
        self.assertEqual(nx.shortest_path_length(g,'b0','s0',weight='length'),20)
        self.assertEqual(nx.shortest_path_length(g,0,1,weight='length'),100)
    def test_coincident_points_and_parallel_edges(self):
        g = nx.MultiGraph()
        g.add_edge(0,1,key=0,length=100)
        g.add_edge(0,1,key=1,length=150)
        split_snap_groups(g,[('p',[(0,1,0,0,40,40,60,0),(0,1,0,0,40,40,60,0)])])
        self.assertEqual(nx.shortest_path_length(g,'p0','p1',weight='length'),0)
        self.assertEqual(g.edges[0,1,1]['length'],150)
    def test_access_and_slope_influence_destination(self):
        g=nx.MultiGraph()
        g.add_edge('b','a',length=10,general=40)
        g.add_edge('b','c',length=20,general=20)
        costs,lengths,sources=shortest_effective(g,['a','c'],'general')
        self.assertEqual((costs['b'],lengths['b'],sources['b']),(20,20,'c'))

if __name__=='__main__': unittest.main()
